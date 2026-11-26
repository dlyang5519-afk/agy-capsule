/**
 * Bundled read-only transcript & token analyzer (zero plugin dependency).
 * Derived from agy-context — Copyright (c) 2026 Ahmet Sahin (MIT License).
 */
/**
 * Read-only token accounting and customization discovery engine for the Context sidecar.
 *
 * Reads Antigravity's on-disk conversation transcripts (`transcript_full.jsonl` /
 * `transcript.jsonl`), customization directories (`~/.gemini/config/`, builtin,
 * active workspaces), and MCP schema directories (`<appData>/mcp/`), combining
 * exact model-reported step token counts (`input_tokens`, `cache_read_tokens`,
 * `output_tokens`) with progressive-disclosure / deferred inventory.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ID_RE = /^[0-9a-f-]{8,}$/i;
const UUID_FIND_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export const DEFAULT_CONTEXT_LIMIT = 1048576; // 1M tokens

const MODEL_IDS = {
  246: 'gemini-2.5-pro',
  312: 'gemini-2.5-flash',
  313: 'gemini-2.5-flash-thinking',
  329: 'gemini-2.5-flash-thinking',
  330: 'gemini-2.5-flash-lite',
  281: 'claude-sonnet-4',
  282: 'claude-sonnet-4',
  290: 'claude-opus-4',
  291: 'claude-opus-4',
  333: 'claude-sonnet-4-5',
  334: 'claude-sonnet-4-5',
  340: 'claude-haiku-4-5',
  341: 'claude-haiku-4-5',
  342: 'gpt-oss-120b-medium',
  1016: 'gemini-3.1-pro',
  1018: 'gemini-3-flash-preview',
  1020: 'gemini-3.5-flash-medium',
  1021: 'gemini-3.1-flash-image',
  1026: 'claude-opus-4-6',
  1035: 'claude-sonnet-4-6',
  1036: 'gemini-3.1-pro',
  1037: 'gemini-3.1-pro',
  1047: 'gemini-3-flash-preview',
  1050: 'gemini-3.1-flash-lite',
  1071: 'gemini-3.6-flash-high',
  1072: 'gemini-3.6-flash-medium',
  1073: 'gemini-3.6-flash-low',
  1084: 'gemini-3-flash-preview',
  1132: 'gemini-3.5-flash-high',
  1133: 'gemini-3.5-flash-high',
  1187: 'gemini-3.5-flash-extra-low',
  1196: 'gemini-3.6-flash',
  1266: 'gemini-3.6-flash',
  1298: 'gemini-3.7-flash-high',
  1299: 'gemini-3.7-flash-medium',
  1300: 'gemini-3.7-flash-low',
  1301: 'gemini-3.7-flash-tiered',
  1318: 'gemini-3.8-flash-high',
  1319: 'gemini-3.8-flash-medium',
  1320: 'gemini-3.8-flash-low',
  1322: 'gemini-3.8-flash-tiered',
  1400: 'claude-opus-5-5-low',
  1401: 'claude-opus-5-5-medium',
  1402: 'claude-opus-5-5-high',
  1403: 'claude-sonnet-5-5-low',
  1404: 'claude-sonnet-5-5-medium',
  1405: 'claude-sonnet-5-5-high',
  1417: 'gemini-4-argon-high',
  1418: 'gemini-4-argon-medium',
  1419: 'gemini-4-argon-low',
  1427: 'gemini-4-carbon-high',
  1437: 'gemini-4-carbon-medium',
  1438: 'gemini-4-carbon-low',
  1525: 'gemini-4-hydrogen-high',
  1526: 'gemini-4-hydrogen-medium',
  1527: 'gemini-4-hydrogen-low',
  1528: 'gemini-4-hydrogen-xhigh',
  1667: 'gemini-pro-orchestrator',
  1669: 'gemini-flash-worker-agy',
  1681: 'gemini-pro-orchestrator-argon',
};

const modelDecoder = new TextDecoder('utf-8', { fatal: true });

function decodeProtoFields(bytes) {
  const result = new Map();
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return result;
  let offset = 0;

  const readVarint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= bytes.length) throw new Error('Truncated varint');
      const byte = bytes[offset++];
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
      }
    }
    throw new Error('Malformed varint');
  };

  while (offset < bytes.length) {
    const tag = readVarint();
    if (typeof tag !== 'number') break;
    const fieldNumber = Math.floor(tag / 8);
    const wire = tag % 8;
    if (fieldNumber === 0) break;

    if (wire === 0) {
      const v = readVarint();
      let arr = result.get(fieldNumber);
      if (!arr) {
        arr = [];
        result.set(fieldNumber, arr);
      }
      arr.push(v);
    } else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? readVarint() : wire === 1 ? 8 : 4;
      if (typeof length !== 'number' || length < 0 || length > bytes.length - offset) break;
      const slice = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire === 2) {
        let arr = result.get(fieldNumber);
        if (!arr) {
          arr = [];
          result.set(fieldNumber, arr);
        }
        arr.push(slice);
      }
    } else {
      break;
    }
  }
  return result;
}

function protoNum(map, key) {
  const v = map.get(key)?.[0];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function protoBytes(map, key) {
  const v = map.get(key)?.[0];
  return v instanceof Uint8Array ? v : undefined;
}

function protoNested(map, key) {
  const b = protoBytes(map, key);
  if (!b) return new Map();
  try {
    return decodeProtoFields(b);
  } catch {
    return new Map();
  }
}

function protoText(map, key) {
  const b = protoBytes(map, key);
  if (!b) return '';
  try {
    return modelDecoder.decode(b).trim();
  } catch {
    return '';
  }
}

function normalizeModelSlug(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';
  let s = rawName
    .trim()
    .toLowerCase()
    .replace(/\s*\(([^)]*)\)\s*$/, '-$1')
    .replace(/\s+/g, '-');
  if (s.startsWith('claude-')) {
    s = s
      .replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/, 'claude-$2-$1')
      .replaceAll('.', '-');
  }
  return s;
}

function isConcreteModelSlug(model) {
  return (
    (model === 'gemini-pro-orchestrator' ||
      model === 'gemini-pro-orchestrator-argon' ||
      model === 'gemini-flash-worker-agy' ||
      /^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)/.test(model)) &&
    !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model) &&
    !/^gemini-4-argon-[bf]$/.test(model) &&
    !/^gemini-3\.8-flash-n$/.test(model)
  );
}

function extractEntryModelSlug(bytes, isStep) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return '';
  try {
    const root = decodeProtoFields(bytes);
    if (!isStep && protoBytes(root, 1) === undefined) return '';
    const data = isStep ? root : protoNested(root, 1);
    const modelMsg = isStep ? protoNested(data, 24) : data;
    const primaryUsageBytes = protoBytes(data, isStep ? 9 : 4);
    let primaryUsageId = 0;
    if (primaryUsageBytes) {
      try {
        primaryUsageId = protoNum(decodeProtoFields(primaryUsageBytes), 1);
      } catch {}
    }

    const candidates = [
      protoText(modelMsg, isStep ? 12 : 19),
      protoText(modelMsg, isStep ? 8 : 21),
    ]
      .map(normalizeModelSlug)
      .filter(Boolean);

    const concrete = candidates.find(isConcreteModelSlug);
    if (concrete) return concrete;

    const modelId = protoNum(modelMsg, isStep ? 1 : 3) || primaryUsageId;
    if (modelId > 0 && MODEL_IDS[modelId]) return MODEL_IDS[modelId];

    return candidates.find((n) => n && !/^model[_-]/.test(n)) || '';
  } catch {
    return '';
  }
}

function formatModelLabel(slug) {
  const id = normalizeModelSlug(slug);
  if (!id) return 'Default model';
  if (id === 'gemini-pro-orchestrator') return 'Orchestrator (Carbon)';
  if (id === 'gemini-pro-orchestrator-argon') return 'Orchestrator (Argon)';
  if (id === 'gemini-flash-worker-agy') return 'Gemini Flash Worker';
  const effortMatch = id.match(/^(.*?)-(extra-low|low|medium|high|xhigh|tiered)$/);
  const base = effortMatch ? effortMatch[1] : id;
  const effort = effortMatch ? effortMatch[2].replace('-', ' ') : '';
  const claudeMatch = base.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/);
  let label;
  if (claudeMatch) {
    const tier = claudeMatch[1].replace(/^./, (c) => c.toUpperCase());
    const ver = claudeMatch[3] ? `${claudeMatch[2]}.${claudeMatch[3]}` : claudeMatch[2];
    label = `Claude ${tier} ${ver}`;
  } else if (base.startsWith('gpt-oss-')) {
    label = base.replace(/^gpt-oss-/, 'GPT-OSS ').toUpperCase();
  } else {
    label = base
      .split('-')
      .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(' ');
  }
  if (!effort) return label;
  const effTitle = effort.replace(/\b\w/g, (c) => c.toUpperCase());
  return `${label} (${effTitle})`;
}

export function resolveModelContextLimit(rawModel, agyMaxTokenLimit = 0) {
  const modelId = normalizeModelSlug(rawModel);
  let modelMaxTokens = DEFAULT_CONTEXT_LIMIT;

  if (modelId) {
    if (/^gpt-oss-120b/.test(modelId)) {
      modelMaxTokens = 131072;
    } else if (/^claude-(?:sonnet|opus|haiku)-4-5(?:$|-)/.test(modelId) || /^claude-(?:sonnet|opus)-4(?:$|-2)/.test(modelId)) {
      modelMaxTokens = 200000;
    } else if (/^claude-(?:opus|sonnet|haiku)-5(?:$|-)/.test(modelId) || /^claude-(?:opus|sonnet)-4-(?:6|7|8)(?:$|-)/.test(modelId)) {
      modelMaxTokens = 1000000;
    } else if (/^gemini-3\.1-flash-image/.test(modelId)) {
      modelMaxTokens = 131072;
    } else if (/^gemini-3-pro-image/.test(modelId)) {
      modelMaxTokens = 65536;
    } else if (/^gemini-2\.5-flash-image/.test(modelId)) {
      modelMaxTokens = 32768;
    } else {
      modelMaxTokens = DEFAULT_CONTEXT_LIMIT;
    }
  }

  const agyDefault = modelId.includes('orchestrator')
    ? 512000
    : Math.min(modelMaxTokens, 256000);
  const contextLimit = agyMaxTokenLimit > 0 ? agyMaxTokenLimit : agyDefault;

  return {
    modelId: modelId || '',
    modelLabel: formatModelLabel(modelId),
    contextLimit,
    modelMaxTokens,
    limitSource: agyMaxTokenLimit > 0 ? 'antigravity' : 'antigravity-default',
  };
}

function mapPlaceholderEnumToSlug(enumName) {
  if (!enumName) return '';
  if (enumName === 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM') return 'gpt-oss-120b-medium';
  if (enumName === 'MODEL_GOOGLE_GEMINI_2_5_FLASH') return 'gemini-2.5-flash';
  if (enumName === 'MODEL_GOOGLE_GEMINI_2_5_PRO') return 'gemini-2.5-pro';
  if (enumName === 'MODEL_CLAUDE_4_5_HAIKU') return 'claude-haiku-4-5';
  const m = enumName.match(/^MODEL_PLACEHOLDER_M(\d+)$/);
  if (m) {
    return MODEL_IDS[1000 + Number(m[1])] || '';
  }
  return '';
}

const convModelCache = new Map(); // convId -> { fp, info }

function detectConversationModel(appData, convId) {
  const dbPath = join(appData, 'conversations', `${convId}.db`);
  const walPath = `${dbPath}-wal`;
  const pbtxtPath = join(appData, 'antigravity_state.pbtxt');
  const dbSt = statOf(dbPath);
  const walSt = statOf(walPath);
  const pbSt = statOf(pbtxtPath);
  const fp = `${dbSt.mtime}:${dbSt.size}/${walSt.mtime}:${walSt.size}/${pbSt.mtime}:${pbSt.size}`;

  const hit = convModelCache.get(convId);
  if (hit && hit.fp === fp) return hit.info;

  const foundSlugs = [];
  let agyMaxTokenLimit = 0;
  if (dbSt.isFile && dbSt.size > 0) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
      );
      if (tables.has('steps')) {
        const sRows = db
          .prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx DESC LIMIT 8')
          .all();
        for (const r of sRows) {
          if (r?.metadata instanceof Uint8Array) {
            const slug = extractEntryModelSlug(r.metadata, true);
            if (slug) foundSlugs.push(slug);
          }
        }
      }
      if (tables.has('gen_metadata')) {
        const rowIds = db.prepare('SELECT rowid AS rowid FROM gen_metadata ORDER BY rowid DESC LIMIT 5').all();
        const getGen = db.prepare('SELECT idx, data FROM gen_metadata WHERE rowid = ?');
        for (const { rowid } of rowIds) {
          if (rowid === undefined) continue;
          const row = getGen.get(rowid);
          if (row?.data instanceof Uint8Array) {
            const slug = extractEntryModelSlug(row.data, false);
            if (slug) foundSlugs.push(slug);
          }
        }
      }
      if (tables.has('executor_metadata')) {
        const emRow = db
          .prepare('SELECT data FROM executor_metadata ORDER BY rowid DESC LIMIT 1')
          .get();
        if (emRow?.data instanceof Uint8Array) {
          const root = decodeProtoFields(emRow.data);
          const cc = protoNested(root, 10);
          const cp = protoNested(cc, 2);
          const lim = protoNum(cp, 5);
          if (lim > 0) agyMaxTokenLimit = lim;
        }
      }
    } catch {
      // fall back cleanly if DB is locked or incomplete
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  let selectedSlug =
    foundSlugs.find((s) => isConcreteModelSlug(s) && s !== 'gemini-flash-worker-agy') ||
    foundSlugs.find((s) => isConcreteModelSlug(s)) ||
    foundSlugs[0] ||
    '';

  if (!selectedSlug && pbSt.isFile) {
    const { text } = readCached(pbtxtPath, 512 * 1024);
    const m = text?.match(/last_selected_agent_model:\s*(\S+)/);
    if (m) selectedSlug = mapPlaceholderEnumToSlug(m[1]);
  }

  const info = resolveModelContextLimit(selectedSlug, agyMaxTokenLimit);
  if (convModelCache.size > 200) convModelCache.clear();
  convModelCache.set(convId, { fp, info });
  return info;
}

const BUILTIN_SUBAGENTS = [
  { name: 'self', description: 'Subagent inheriting full parent config and tools.' },
  { name: 'research', description: 'Read-only codebase and web research subagent.' },
  { name: 'browser', description: 'Built-in webview browser automation subagent.' },
  { name: 'image-generator', description: 'Image generation and editing subagent.' },
];

// ---------------------------------------------------------------------------
// App Data Dir & File Helpers
// ---------------------------------------------------------------------------

/**
 * Locate Antigravity appData directories containing `brain/`.
 * Inside a Language Server sidecar, scopes strictly to the host's appData dir.
 */
export function findAppDataDirs() {
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (dataDir) {
    for (let d = dataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) !== 'sidecar_data') continue;
      const appData = dirname(d);
      return existsSync(join(appData, 'brain')) ? [appData] : [];
    }
    return [];
  }
  const root = join(homedir(), '.gemini');
  return safeReaddir(root)
    .sort()
    .map((name) => join(root, name))
    .filter((c) => existsSync(join(c, 'brain')));
}

export function resolveConversationAppData(convId) {
  if (!convId || !ID_RE.test(convId)) return null;
  for (const appData of findAppDataDirs()) {
    const convDir = join(appData, 'brain', convId);
    if (existsSync(convDir)) return appData;
  }
  return null;
}

export function listRecentConversations(limit = 20) {
  const seen = new Set();
  const list = [];
  for (const appData of findAppDataDirs()) {
    const brainRoot = join(appData, 'brain');
    for (const id of safeReaddir(brainRoot)) {
      if (!ID_RE.test(id) || seen.has(id)) continue;
      const logsDir = join(brainRoot, id, '.system_generated', 'logs');
      const fullStat = statOf(join(logsDir, 'transcript_full.jsonl'));
      const compactStat = fullStat.size >= 0 ? fullStat : statOf(join(logsDir, 'transcript.jsonl'));
      if (compactStat.size < 0) continue;
      seen.add(id);
      list.push({ id, appData, mtime: compactStat.mtime, size: compactStat.size });
    }
  }
  list.sort((a, b) => b.mtime - a.mtime);
  return list.slice(0, limit);
}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReaddirWithTypes(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function statOf(path) {
  try {
    const s = statSync(path);
    return { mtime: s.mtimeMs, size: s.size, isFile: s.isFile(), isDir: s.isDirectory() };
  } catch {
    return { mtime: 0, size: -1, isFile: false, isDir: false };
  }
}

const fileCache = new Map(); // path -> { key, text }
export function readCached(path, maxBytes = Infinity) {
  const s = statOf(path);
  if (s.size < 0 || !s.isFile) return { text: null, ...s };
  if (s.size > maxBytes) return { text: null, tooLarge: true, ...s };
  const key = `${s.mtime}:${s.size}`;
  const hit = fileCache.get(path);
  if (hit && hit.key === key) return { text: hit.text, ...s };
  let text = null;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return { text: null, ...s };
  }
  if (fileCache.size > 600) fileCache.clear();
  fileCache.set(path, { key, text });
  return { text, ...s };
}

function readJsonSafe(path) {
  const { text } = readCached(path, 2 * 1024 * 1024);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function unquote(v) {
  if (typeof v !== 'string') return v == null ? '' : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return String(JSON.parse(s));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Token Estimation Helpers (used ONLY for proportional splits & deferred files)
// ---------------------------------------------------------------------------

/**
 * Estimate tokens in text based on density (JSON/code vs natural prose).
 */
export function estTextTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  const len = text.length;
  if (len === 0) return 0;
  // Detect code/JSON density from punctuation ratio on a fast prefix sample.
  const sample = len > 2000 ? text.slice(0, 2000) : text;
  let punct = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 123 || c === 125 || c === 91 || c === 93 || c === 58 || c === 34 || c === 60 || c === 62 || c === 92) {
      punct++;
    }
  }
  const density = punct / sample.length;
  const charsPerToken = density > 0.08 ? 3.45 : 3.85;
  return Math.max(1, Math.ceil(len / charsPerToken));
}

function estStepTokens(step) {
  if (!step || typeof step !== 'object') return 0;
  let tok = 0;
  if (typeof step.content === 'string' && step.content) {
    tok += estTextTokens(step.content);
  }
  if (Array.isArray(step.media)) {
    tok += step.media.length * 258;
  }
  return tok + 6; // small role/framing overhead per message
}

function parseYamlFrontmatter(text) {
  if (!text || !text.startsWith('---')) return { meta: {}, body: text || '' };
  const endIdx = text.indexOf('\n---', 3);
  if (endIdx < 0) return { meta: {}, body: text };
  const rawMeta = text.slice(3, endIdx).trim();
  const body = text.slice(endIdx + 4).trimStart();
  const meta = {};
  const lines = rawMeta.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (val === '>-' || val === '>' || val === '|-' || val === '|') {
      const parts = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        i++;
        parts.push(lines[i].trim());
      }
      val = parts.join(' ');
    } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    meta[key] = val;
  }
  return { meta, body };
}

// ---------------------------------------------------------------------------
// Language Server Plugin Query (Read-Only, Cached)
// ---------------------------------------------------------------------------

const LS_PLUGINS_TTL_MS = 10000;
let lsPluginsCache = { key: '', fetchedAt: 0, plugins: null };

async function fetchLsPlugins(workspaceUris) {
  const addr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!addr || !csrf) return null;
  const key = workspaceUris.join('|');
  const now = Date.now();
  if (lsPluginsCache.plugins && lsPluginsCache.key === key && now - lsPluginsCache.fetchedAt < LS_PLUGINS_TTL_MS) {
    return lsPluginsCache.plugins;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://${addr}/exa.language_server_pb.LanguageServerService/GetAllPlugins`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrf,
      },
      body: JSON.stringify(workspaceUris.length ? { workspaceUris } : {}),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data?.plugins)) {
      lsPluginsCache = { key, fetchedAt: now, plugins: data.plugins };
      return data.plugins;
    }
  } catch {
    // Standalone / LS unreachable -> fall back to filesystem scan.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Workspace URI Conversion & Discovery
// ---------------------------------------------------------------------------

function uriToPath(uri) {
  if (!uri || typeof uri !== 'string') return null;
  if (uri.startsWith('file://')) {
    try {
      return fileURLToPath(uri);
    } catch {
      return decodeURIComponent(uri.slice(7));
    }
  }
  if (isAbsolute(uri)) return uri;
  return null;
}

// ---------------------------------------------------------------------------
// Customization & MCP Inventory
// ---------------------------------------------------------------------------

function readConfigDisabledMap(configDir) {
  const cfg = readJsonSafe(join(configDir, 'config.json'));
  const map = new Map();
  if (cfg?.plugins && typeof cfg.plugins === 'object') {
    for (const [dir, entry] of Object.entries(cfg.plugins)) {
      if (entry && typeof entry.enabled === 'boolean') {
        map.set(dir, entry.enabled);
      }
    }
  }
  return map;
}

function collectEnabledPlugins(appData, configDir, workspaceDirs, lsPlugins) {
  const byName = new Map(); // global unique plugin name -> plugin record

  if (Array.isArray(lsPlugins)) {
    for (const p of lsPlugins) {
      if (!p || p.disabled) continue;
      const pPath = uriToPath(p.path);
      if (!pPath || !existsSync(pPath)) continue;
      const name = p.name || basename(pPath);
      if (!byName.has(name)) {
        byName.set(name, { name, dir: basename(pPath), path: pPath, isBuiltin: Boolean(p.isBuiltin) });
      }
    }
    return [...byName.values()];
  }

  const enabledOverride = readConfigDisabledMap(configDir);
  const roots = [
    ...workspaceDirs.map((w) => ({ dir: join(w, '.agents', 'plugins'), isBuiltin: false })),
    { dir: join(configDir, 'plugins'), isBuiltin: false },
    { dir: join(appData, 'builtin', 'plugins'), isBuiltin: true },
  ];

  for (const root of roots) {
    for (const entry of safeReaddirWithTypes(root.dir)) {
      if (!entry.isDirectory()) continue;
      const pPath = join(root.dir, entry.name);
      const manifest =
        readJsonSafe(join(pPath, 'plugin.json')) ||
        readJsonSafe(join(pPath, '.antigravity-plugin', 'plugin.json')) ||
        readJsonSafe(join(pPath, '.gemini-plugin', 'plugin.json'));
      if (!manifest) continue;
      const dirKey = entry.name;
      const override = enabledOverride.get(dirKey);
      const isEnabled = override !== undefined ? override : !manifest.disabled;
      if (!isEnabled) continue;
      const name = manifest.name || dirKey;
      if (!byName.has(name)) {
        byName.set(name, { name, dir: dirKey, path: pPath, isBuiltin: root.isBuiltin });
      }
    }
  }
  return [...byName.values()];
}

function findMarkdownFiles(dir, recursive = false) {
  const out = [];
  for (const entry of safeReaddirWithTypes(dir)) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    } else if (recursive && entry.isDirectory()) {
      out.push(...findMarkdownFiles(full, true));
    }
  }
  return out;
}

const custCache = new Map(); // cacheKey -> { builtAt, data }
const CUST_TTL_MS = 4000;

export async function scanCustomizations(appData, workspaceUris = [], readFileRealPaths = new Set()) {
  const home = homedir();
  const configDir = join(home, '.gemini', 'config');
  const workspaceDirs = workspaceUris.map(uriToPath).filter((p) => p && existsSync(p));
  const lsPlugins = await fetchLsPlugins(workspaceUris);

  const plugins = collectEnabledPlugins(appData, configDir, workspaceDirs, lsPlugins);
  const pluginKey = plugins.map((p) => `${p.name}:${p.path}`).join(',');
  const readKey = [...readFileRealPaths].sort().join(',');
  const cacheKey = `${appData}|${workspaceDirs.join(',')}|${pluginKey}|${readKey}`;

  const now = Date.now();
  const hit = custCache.get(cacheKey);
  if (hit && now - hit.builtAt < CUST_TTL_MS) return hit.data;

  // --- 1. Rules & Memory Files ---
  const ruleCandidates = [];
  for (const w of workspaceDirs) {
    for (const fname of ['GEMINI.md', 'AGENTS.md']) {
      const f = join(w, fname);
      if (existsSync(f)) ruleCandidates.push({ path: f, scope: 'Workspace', label: fname });
    }
    for (const f of findMarkdownFiles(join(w, '.agents', 'rules'), true)) {
      ruleCandidates.push({ path: f, scope: 'Workspace', label: basename(f) });
    }
  }
  for (const fname of ['GEMINI.md', 'AGENTS.md']) {
    const f = join(configDir, fname);
    if (existsSync(f)) ruleCandidates.push({ path: f, scope: 'Global', label: fname });
  }
  for (const f of findMarkdownFiles(join(configDir, 'rules'), true)) {
    ruleCandidates.push({ path: f, scope: 'Global', label: basename(f) });
  }
  for (const p of plugins) {
    for (const f of findMarkdownFiles(join(p.path, 'rules'), true)) {
      ruleCandidates.push({ path: f, scope: `Plugin:${p.name}`, label: `${p.name}/${basename(f)}` });
    }
  }

  const seenRuleReal = new Set();
  const rules = [];
  let activeRulesTokens = 0;
  let deferredRulesTokens = 0;

  for (const rc of ruleCandidates) {
    const real = safeRealpath(rc.path);
    if (!real || seenRuleReal.has(real)) continue;
    seenRuleReal.add(real);
    const { text, size } = readCached(real, 512 * 1024);
    if (text == null) continue;
    const { meta } = parseYamlFrontmatter(text);
    const trigger = meta.trigger || 'always_on';
    const isLoaded = trigger === 'always_on' || readFileRealPaths.has(real);
    const tokens = estTextTokens(text);
    if (isLoaded) activeRulesTokens += tokens;
    else deferredRulesTokens += tokens;
    rules.push({
      path: real,
      label: rc.label,
      scope: rc.scope,
      trigger,
      loaded: isLoaded,
      tokens,
      bytes: size,
    });
  }

  // --- 2. Skills (Progressive Disclosure) ---
  const skillRoots = [
    ...workspaceDirs.map((w) => ({ dir: join(w, '.agents', 'skills'), scope: 'Workspace' })),
    { dir: join(configDir, 'skills'), scope: 'Global' },
    ...plugins.flatMap((p) => {
      const list = [{ dir: join(p.path, 'skills'), scope: `Plugin:${p.name}` }];
      if (existsSync(join(p.path, 'SKILL.md'))) {
        list.push({ directSkillDir: p.path, scope: `Plugin:${p.name}` });
      }
      return list;
    }),
    { dir: join(appData, 'builtin', 'skills'), scope: 'Builtin' },
  ];

  const seenSkillNames = new Set();
  const seenSkillPaths = new Set();
  const skills = [];
  let activeSkillsIndexTokens = 0;
  let loadedSkillsBodyTokens = 0;
  let deferredSkillsTokens = 0;

  const inspectSkillDir = (skillDir, scope) => {
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) return;
    const real = safeRealpath(skillFile);
    if (!real || seenSkillPaths.has(real)) return;
    const { text, size } = readCached(real, 512 * 1024);
    if (text == null) return;
    const { meta, body } = parseYamlFrontmatter(text);
    const name = meta.name || basename(skillDir);
    if (seenSkillNames.has(name)) return;
    seenSkillNames.add(name);
    seenSkillPaths.add(real);

    const desc = meta.description || '';
    // System prompt lists `- <name> (<path>): <description>`
    const indexTokens = estTextTokens(`- ${name} (${skillFile}): ${desc}`);
    const bodyTokens = estTextTokens(body);
    const loaded = readFileRealPaths.has(real);

    activeSkillsIndexTokens += indexTokens;
    if (loaded) loadedSkillsBodyTokens += bodyTokens;
    else deferredSkillsTokens += bodyTokens;

    skills.push({
      name,
      path: real,
      scope,
      indexTokens,
      bodyTokens,
      loaded,
      bytes: size,
    });
  };

  for (const sr of skillRoots) {
    if (sr.directSkillDir) {
      inspectSkillDir(sr.directSkillDir, sr.scope);
      continue;
    }
    for (const entry of safeReaddirWithTypes(sr.dir)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      inspectSkillDir(join(sr.dir, entry.name), sr.scope);
    }
  }

  // --- 3. Custom Agents & Subagent Definitions ---
  const agentRoots = [
    ...workspaceDirs.map((w) => ({ dir: join(w, '.agents', 'agents'), scope: 'Workspace' })),
    { dir: join(configDir, 'agents'), scope: 'Global' },
    ...plugins.map((p) => ({ dir: join(p.path, 'agents'), scope: `Plugin:${p.name}` })),
  ];
  const customAgents = [];
  const seenAgentNames = new Set();
  let customAgentsTokens = 0;

  for (const ar of agentRoots) {
    for (const f of findMarkdownFiles(ar.dir, false)) {
      const real = safeRealpath(f);
      if (!real) continue;
      const { text, size } = readCached(real, 256 * 1024);
      if (text == null) continue;
      const { meta } = parseYamlFrontmatter(text);
      const name = meta.name || basename(f, '.md');
      if (seenAgentNames.has(name)) continue;
      seenAgentNames.add(name);
      // In system prompt <subagents>, only name + description is injected upfront.
      const declTokens = estTextTokens(`- ${name}: ${meta.description || text.slice(0, 200)}`);
      customAgentsTokens += declTokens;
      customAgents.push({
        name,
        path: real,
        scope: ar.scope,
        tokens: declTokens,
        fullTokens: estTextTokens(text),
        bytes: size,
        builtin: false,
      });
    }
  }
  for (const ba of BUILTIN_SUBAGENTS) {
    if (seenAgentNames.has(ba.name)) continue;
    const declTokens = estTextTokens(`- ${ba.name}: ${ba.description}`) + 25;
    customAgentsTokens += declTokens;
    customAgents.push({
      name: ba.name,
      path: null,
      scope: 'Builtin',
      tokens: declTokens,
      fullTokens: declTokens,
      bytes: 0,
      builtin: true,
    });
  }

  // --- 4. MCP Servers, Schemas & Instructions ---
  const mcpConfigs = new Map(); // serverName -> { disabled, source }
  const ingestMcpConfig = (cfgPath, source, prefix = '') => {
    const cfg = readJsonSafe(cfgPath);
    const servers = cfg?.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : null;
    if (!servers) return;
    for (const [name, s] of Object.entries(servers)) {
      const fullName = prefix ? `${prefix}_${name}` : name;
      mcpConfigs.set(fullName, { disabled: Boolean(s?.disabled), source });
    }
  };
  ingestMcpConfig(join(configDir, 'mcp_config.json'), 'Global');
  for (const p of plugins) {
    ingestMcpConfig(join(p.path, 'mcp_config.json'), `Plugin:${p.name}`, p.name);
  }

  const mcpRoot = join(appData, 'mcp');
  const mcpServers = [];
  let mcpActiveManifestTokens = 0;
  let mcpInstructionsTokens = 0;
  let mcpDeferredTokens = 0;
  let mcpLoadedSchemaTokens = 0;
  let totalMcpTools = 0;

  for (const entry of safeReaddirWithTypes(mcpRoot)) {
    if (!entry.isDirectory()) continue;
    const serverName = entry.name;
    const serverDir = join(mcpRoot, serverName);
    const cfgEntry = mcpConfigs.get(serverName);
    const disabled = cfgEntry ? cfgEntry.disabled : false;

    const instPath = safeRealpath(join(serverDir, 'instructions.md'));
    let instTokens = 0;
    if (instPath) {
      const { text } = readCached(instPath, 256 * 1024);
      if (text) instTokens = estTextTokens(text);
    }

    const tools = [];
    let deferredTok = 0;
    let loadedTok = 0;
    let eagerTok = 0;

    for (const f of safeReaddirWithTypes(serverDir)) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue;
      const tPath = safeRealpath(join(serverDir, f.name));
      if (!tPath) continue;
      const { text, size } = readCached(tPath, 256 * 1024);
      if (text == null) continue;
      const tTok = estTextTokens(text);
      const tName = f.name.replace(/\.json$/, '');
      const isRead = readFileRealPaths.has(tPath);
      if (isRead) loadedTok += tTok;
      else deferredTok += tTok;

      tools.push({
        name: tName,
        path: tPath,
        tokens: tTok,
        loaded: isRead,
        bytes: size,
      });
    }

    // Active manifest cost in <mcp_servers> (Lazy section listing server + tool names)
    const manifestHeaderTok = tools.length
      ? estTextTokens(`# ${serverName}\nLazy:\n` + tools.map((t) => t.name).join('\n'))
      : estTextTokens(`# ${serverName}`);
    if (!disabled) {
      mcpActiveManifestTokens += manifestHeaderTok + eagerTok;
      mcpInstructionsTokens += instTokens;
      mcpDeferredTokens += deferredTok;
      mcpLoadedSchemaTokens += loadedTok;
    }
    totalMcpTools += tools.length;

    tools.sort((a, b) => b.tokens - a.tokens);
    mcpServers.push({
      name: serverName,
      source: cfgEntry?.source || 'Discovered',
      disabled,
      toolCount: tools.length,
      manifestTokens: manifestHeaderTok,
      instructionsPath: instPath,
      instructionsTokens: instTokens,
      deferredTokens: deferredTok,
      loadedTokens: loadedTok,
      tools,
    });
  }

  for (const [name, info] of mcpConfigs.entries()) {
    if (mcpServers.some((s) => s.name === name)) continue;
    mcpServers.push({
      name,
      source: info.source,
      disabled: info.disabled,
      toolCount: 0,
      manifestTokens: info.disabled ? 0 : 12,
      instructionsPath: null,
      instructionsTokens: 0,
      deferredTokens: 0,
      loadedTokens: 0,
      tools: [],
    });
    if (!info.disabled) mcpActiveManifestTokens += 12;
  }

  mcpServers.sort((a, b) => Number(a.disabled) - Number(b.disabled) || b.deferredTokens - a.deferredTokens);

  const data = {
    rules,
    activeRulesTokens,
    deferredRulesTokens,
    skills,
    activeSkillsIndexTokens,
    loadedSkillsBodyTokens,
    deferredSkillsTokens,
    customAgents,
    customAgentsTokens,
    mcpServers,
    totalMcpTools,
    mcpActiveManifestTokens,
    mcpInstructionsTokens,
    mcpDeferredTokens,
    mcpLoadedSchemaTokens,
    plugins: plugins.map((p) => ({ name: p.name, dir: p.dir, path: p.path, isBuiltin: p.isBuiltin })),
  };

  if (custCache.size > 40) custCache.clear();
  custCache.set(cacheKey, { builtAt: now, data });
  return data;
}

// ---------------------------------------------------------------------------
// Safe File URI Allowlist
// ---------------------------------------------------------------------------

function buildAllowedRoots(appData, workspaceUris, extraPaths = []) {
  const home = homedir();
  const candidates = [
    join(home, '.gemini'),
    join(home, '.agents'),
    join(home, '.cua-driver'),
    appData,
    ...workspaceUris.map(uriToPath),
    ...extraPaths.map((p) => dirname(p)),
  ];
  const roots = new Set();
  for (const c of candidates) {
    if (!c) continue;
    const real = safeRealpath(c);
    if (real) roots.add(real.endsWith(sep) ? real : real + sep);
  }
  return [...roots];
}

function canonicalAllowedFile(target, roots) {
  if (!target || typeof target !== 'string' || target.length > 4096 || !isAbsolute(target)) return null;
  if (/[%\0\\]/.test(target)) return null;
  if (target.split('/').some((seg) => seg === '.' || seg === '..')) return null;
  const real = safeRealpath(target);
  if (!real) return null;
  const st = statOf(real);
  if (!st.isFile) return null;
  const ok = roots.some((r) => real.startsWith(r) || real === r.slice(0, -1));
  return ok ? pathToFileURL(real).href : null;
}

// ---------------------------------------------------------------------------
// Subagent & Artifact Discovery
// ---------------------------------------------------------------------------

function summarizeSubagentTranscript(appData, convId) {
  const logDir = join(appData, 'brain', convId, '.system_generated', 'logs');
  const tPath = existsSync(join(logDir, 'transcript_full.jsonl'))
    ? join(logDir, 'transcript_full.jsonl')
    : join(logDir, 'transcript.jsonl');
  const { text, mtime } = readCached(tPath, 16 * 1024 * 1024);
  if (!text) return null;
  let steps = 0;
  let lastPrompt = 0;
  let totalOut = 0;
  let status = 'DONE';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      steps++;
      if (s.status) status = s.status;
      if (s.type === 'PLANNER_RESPONSE') {
        const p = (s.input_tokens || 0) + (s.cache_read_tokens || 0);
        if (p > 0) lastPrompt = p;
        totalOut += s.output_tokens || 0;
      }
    } catch {
      // skip torn line
    }
  }
  return { steps, promptTokens: lastPrompt, outputTokens: totalOut, status, mtime };
}

function scanBrainArtifacts(appData, convId) {
  const convDir = join(appData, 'brain', convId);
  const out = [];
  for (const entry of safeReaddirWithTypes(convDir)) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    if (!/\.(md|txt|json|html|svg)$/i.test(entry.name)) continue;
    const real = safeRealpath(join(convDir, entry.name));
    if (!real) continue;
    const { text, size, mtime } = readCached(real, 512 * 1024);
    out.push({
      name: entry.name,
      path: real,
      bytes: size,
      tokens: text != null ? estTextTokens(text) : Math.ceil(Math.max(0, size) / 3.8),
      mtime,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ---------------------------------------------------------------------------
// Core Conversation Analysis
// ---------------------------------------------------------------------------

function describeToolCallShort(tc) {
  const name = tc?.name || '';
  if (!name) return { label: 'tool', targetPath: null };
  const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const path = unquote(args.Path || args.AbsolutePath || args.TargetFile || '');
  if (path) return { label: `${name} (${basename(path)})`, targetPath: path };
  const summary = unquote(args.toolSummary || args.toolAction || '');
  if (summary) return { label: `${name}: ${summary}`, targetPath: null };
  if (name === 'run_command' && args.CommandLine) {
    const cmd = unquote(args.CommandLine).replace(/\s+/g, ' ').slice(0, 48);
    return { label: `run_command: ${cmd}`, targetPath: null };
  }
  if (name === 'invoke_subagent' && args.TypeName) {
    return { label: `subagent: ${unquote(args.TypeName)} (${unquote(args.Role || '')})`.trim(), targetPath: null };
  }
  if (name === 'call_mcp_tool' && args.ServerName && args.ToolName) {
    return { label: `mcp: ${unquote(args.ServerName)}/${unquote(args.ToolName)}`, targetPath: null };
  }
  return { label: name, targetPath: null };
}

function parseTranscriptSteps(rawText) {
  const steps = [];
  if (!rawText) return steps;
  for (const line of rawText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      if (s && typeof s === 'object') steps.push(s);
    } catch {
      // ignore torn trailing JSONL line while streaming
    }
  }
  return steps;
}

function splitPlannerOutput(step, totalOut) {
  if (!totalOut || totalOut <= 0) return { replies: 0, thinking: 0, toolArgs: 0 };
  const replyChars = typeof step.content === 'string' ? step.content.length : 0;
  const thinkChars = typeof step.thinking === 'string' ? step.thinking.length : 0;
  const tcChars = Array.isArray(step.tool_calls) && step.tool_calls.length
    ? JSON.stringify(step.tool_calls).length
    : 0;
  const sum = replyChars + thinkChars + tcChars;
  if (sum <= 0) return { replies: totalOut, thinking: 0, toolArgs: 0 };
  const thinking = Math.round((totalOut * thinkChars) / sum);
  const toolArgs = Math.round((totalOut * tcChars) / sum);
  const replies = Math.max(0, totalOut - thinking - toolArgs);
  return { replies, thinking, toolArgs };
}

/**
 * Reconcile category sum to exact target integer without negative values.
 */
function reconcileActiveBuckets(buckets, targetTotal) {
  const keys = Object.keys(buckets);
  for (const k of keys) {
    buckets[k] = Math.max(0, Math.round(buckets[k]));
  }
  let current = keys.reduce((acc, k) => acc + buckets[k], 0);
  let diff = targetTotal - current;
  if (diff === 0) return buckets;

  // Prefer adjusting malleable buckets first, keeping structural baselines accurate.
  const order = diff > 0
    ? ['systemPrompt', 'toolCallOutputs', 'userMessages', 'agentReplies']
    : ['agentThinking', 'toolCallOutputs', 'agentReplies', 'systemPrompt', 'userMessages', 'toolCallArgs', 'systemTools', 'systemMessages', 'checkpointBuffer'];

  if (diff > 0) {
    buckets[order[0]] += diff;
    return buckets;
  }
  let remaining = -diff;
  for (const k of order) {
    if (remaining <= 0) break;
    const take = Math.min(buckets[k], remaining);
    buckets[k] -= take;
    remaining -= take;
  }
  return buckets;
}

/**
 * Analyze a conversation's transcript + active/deferred customizations.
 */
export async function analyzeConversation(appData, convId, options = {}) {
  const workspaceUris = Array.isArray(options.workspaceUris) ? options.workspaceUris : [];

  if (!appData || !convId || !ID_RE.test(convId)) {
    return { conversationId: convId || null, found: false };
  }

  const modelInfo = detectConversationModel(appData, convId);
  const explicitLimit = Number(options.contextLimit);
  const contextLimit =
    Number.isFinite(explicitLimit) && explicitLimit > 0 ? explicitLimit : modelInfo.contextLimit;

  const logsDir = join(appData, 'brain', convId, '.system_generated', 'logs');
  const fullPath = join(logsDir, 'transcript_full.jsonl');
  const compactPath = join(logsDir, 'transcript.jsonl');
  const fullStat = statOf(fullPath);
  const compactStat = statOf(compactPath);
  const hasFull = fullStat.isFile && fullStat.size >= 0;
  const hasCompact = compactStat.isFile && compactStat.size >= 0;
  const activeTranscriptPath = hasFull ? fullPath : compactPath;

  let steps = [];
  if (hasFull) {
    const fullFile = readCached(fullPath, 128 * 1024 * 1024);
    steps = parseTranscriptSteps(fullFile.text || '');
    if (hasCompact && compactStat.mtime > fullStat.mtime) {
      const compactFile = readCached(compactPath, 128 * 1024 * 1024);
      const compactSteps = parseTranscriptSteps(compactFile.text || '');
      if (compactSteps.length > steps.length) {
        steps = steps.concat(compactSteps.slice(steps.length));
      }
    }
  } else if (hasCompact) {
    const compactFile = readCached(compactPath, 128 * 1024 * 1024);
    steps = parseTranscriptSteps(compactFile.text || '');
  }

  if (!hasFull && !hasCompact && !existsSync(join(appData, 'brain', convId))) {
    return { conversationId: convId, found: false };
  }

  const transcriptMtime = Math.max(fullStat.mtime || 0, compactStat.mtime || 0);
  const transcriptSize = Math.max(0, fullStat.size) + Math.max(0, compactStat.size);

  // Scan chronologically for PLANNER_RESPONSE steps and explicit CHECKPOINT compactions
  const plannerIndices = [];
  const checkpoints = [];
  const turnsHistory = [];
  let lastCompactionStepIdx = -1;
  let lastCheckpointSummaryTokens = 0;
  let sawExplicitCheckpointSinceLastPlanner = false;
  let lastPlannerIdxSoFar = -1;

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type === 'CHECKPOINT') {
      const cpPrompt = (s.input_tokens || 0) + (s.cache_read_tokens || 0);
      let prevPlannerTotal = 0;
      if (lastPlannerIdxSoFar >= 0) {
        const ps = steps[lastPlannerIdxSoFar];
        prevPlannerTotal = (ps.input_tokens || 0) + (ps.cache_read_tokens || 0) + (ps.output_tokens || 0);
      }
      const beforeTokens = cpPrompt > 0 ? cpPrompt : prevPlannerTotal;
      const summaryTokens = s.output_tokens && s.output_tokens > 0 ? s.output_tokens : estStepTokens(s);

      let afterTokens = null;
      for (let look = i + 1; look < steps.length; look++) {
        const nextStep = steps[look];
        if (nextStep.type === 'CHECKPOINT') break;
        if (nextStep.type === 'PLANNER_RESPONSE') {
          const np = (nextStep.input_tokens || 0) + (nextStep.cache_read_tokens || 0);
          if (np > 0) {
            afterTokens = np;
            break;
          }
        }
      }

      checkpoints.push({
        stepIndex: s.step_index ?? i,
        beforeTokens,
        afterTokens,
        savedTokens: afterTokens != null ? Math.max(0, beforeTokens - afterTokens) : 0,
        summaryTokens,
        createdAt: s.created_at || null,
      });
      lastCompactionStepIdx = i;
      lastCheckpointSummaryTokens = summaryTokens;
      sawExplicitCheckpointSinceLastPlanner = true;
    } else if (s.type === 'PLANNER_RESPONSE') {
      const inp = s.input_tokens || 0;
      const cache = s.cache_read_tokens || 0;
      const promptTokens = inp + cache;
      const outputTokens = s.output_tokens || 0;
      if (promptTokens > 0) {
        let implicitDrop = false;
        if (plannerIndices.length > 0 && !sawExplicitCheckpointSinceLastPlanner) {
          const prevIdx = plannerIndices[plannerIndices.length - 1];
          const prevPrompt = (steps[prevIdx].input_tokens || 0) + (steps[prevIdx].cache_read_tokens || 0);
          const drop = prevPrompt - promptTokens;
          // Real compaction drops substantially (avoid false positive on thinking prune across model switches)
          if (drop > Math.max(5000, prevPrompt * 0.12)) {
            implicitDrop = true;
            lastCompactionStepIdx = i - 1;
            lastCheckpointSummaryTokens = 0;
            checkpoints.push({
              stepIndex: s.step_index ?? i,
              beforeTokens: prevPrompt,
              afterTokens: promptTokens,
              savedTokens: drop,
              summaryTokens: 0,
              createdAt: s.created_at || null,
            });
          }
        }
        plannerIndices.push(i);
        lastPlannerIdxSoFar = i;
        turnsHistory.push({
          stepIndex: s.step_index ?? i,
          promptTokens,
          uncachedTokens: inp,
          cachedTokens: cache,
          outputTokens,
          createdAt: s.created_at || null,
          compacted: sawExplicitCheckpointSinceLastPlanner || implicitDrop,
        });
        sawExplicitCheckpointSinceLastPlanner = false;
      }
    }
  }

  // Collect active-window read_file paths (post-compaction) and all spawned subagents
  const readFileRealPaths = new Set();
  const spawnedSubagents = [];
  const seenSubIds = new Set();

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.type !== 'PLANNER_RESPONSE' || !Array.isArray(s.tool_calls)) continue;
    const inActiveWindow = i > lastCompactionStepIdx;
    for (let tIdx = 0; tIdx < s.tool_calls.length; tIdx++) {
      const tc = s.tool_calls[tIdx];
      const name = tc?.name || '';
      const args = tc?.args && typeof tc.args === 'object' ? tc.args : {};
      if (inActiveWindow && (name === 'read_file' || name === 'view_file')) {
        const p = unquote(args.Path || args.AbsolutePath || '');
        const real = p ? safeRealpath(p) : null;
        if (real) readFileRealPaths.add(real);
      }
      if (name === 'invoke_subagent') {
        const resultStep = steps[i + 1 + tIdx];
        const resultText = typeof resultStep?.content === 'string' ? resultStep.content : '';
        const matches = resultText.match(UUID_FIND_RE) || [];
        const subId = matches[0] || null;
        if (!subId || !seenSubIds.has(subId)) {
          if (subId) seenSubIds.add(subId);
          spawnedSubagents.push({
            typeName: unquote(args.TypeName || 'subagent'),
            role: unquote(args.Role || ''),
            model: unquote(args.Model || 'inherit'),
            conversationId: subId,
            stepIndex: s.step_index ?? i,
            stats: subId ? summarizeSubagentTranscript(appData, subId) : null,
          });
        }
      }
    }
  }

  const customizations = await scanCustomizations(appData, workspaceUris, readFileRealPaths);
  const artifacts = scanBrainArtifacts(appData, convId);

  // Compute baseline customization & system breakdown from the very first planner step (or pre-call estimate)
  const firstPrompt = plannerIndices.length
    ? (steps[plannerIndices[0]].input_tokens || 0) + (steps[plannerIndices[0]].cache_read_tokens || 0)
    : 0;

  let preFirstUserEst = 0;
  let preFirstSysEst = 0;
  const preLimit = plannerIndices.length ? plannerIndices[0] : steps.length;
  for (let i = 0; i < preLimit; i++) {
    const st = steps[i];
    const tok = estStepTokens(st);
    if (st.type === 'USER_INPUT') preFirstUserEst += tok;
    else preFirstSysEst += tok;
  }

  const preStepsRaw = preFirstUserEst + preFirstSysEst;
  const preStepsClamped = firstPrompt > 0 ? Math.min(preStepsRaw, Math.floor(firstPrompt * 0.85)) : preStepsRaw;
  const preScale = preStepsRaw > 0 ? preStepsClamped / preStepsRaw : 1;
  const firstUserTokens = Math.round(preFirstUserEst * preScale);
  const firstSysMsgTokens = Math.max(0, preStepsClamped - firstUserTokens);

  const rawFixedBaseline = firstPrompt > 0 ? Math.max(0, firstPrompt - preStepsClamped) : 0;

  // Compute structural customization breakdown inside the fixed baseline
  let rulesBase = customizations.activeRulesTokens;
  let skillsBase = customizations.activeSkillsIndexTokens;
  let mcpActiveBase = customizations.mcpActiveManifestTokens;
  let mcpInstBase = customizations.mcpInstructionsTokens;
  let agentsBase = customizations.customAgentsTokens;

  const rawCustomSum = rulesBase + skillsBase + mcpActiveBase + mcpInstBase + agentsBase;
  if (rawFixedBaseline > 0 && rawCustomSum > rawFixedBaseline * 0.78) {
    const f = (rawFixedBaseline * 0.78) / rawCustomSum;
    rulesBase = Math.round(rulesBase * f);
    skillsBase = Math.round(skillsBase * f);
    mcpActiveBase = Math.round(mcpActiveBase * f);
    mcpInstBase = Math.round(mcpInstBase * f);
    agentsBase = Math.round(agentsBase * f);
  }
  const scaledCustomSum = rulesBase + skillsBase + mcpActiveBase + mcpInstBase + agentsBase;

  let systemToolsBase = 0;
  let systemPromptBase = 0;
  if (rawFixedBaseline > 0) {
    const sysCore = Math.max(0, rawFixedBaseline - scaledCustomSum);
    systemToolsBase = Math.min(9500, Math.round(sysCore * 0.42));
    systemPromptBase = Math.max(0, sysCore - systemToolsBase);
  } else {
    // Conversation hasn't had a planner response yet: show structural baseline estimate
    systemToolsBase = 4800;
    systemPromptBase = 5200;
  }

  const buckets = {
    userMessages: 0,
    agentReplies: 0,
    agentThinking: 0,
    toolCallArgs: 0,
    toolCallOutputs: 0,
    mcpTools: mcpActiveBase,
    mcpInstructions: mcpInstBase,
    systemTools: systemToolsBase,
    systemPrompt: systemPromptBase,
    rulesFiles: rulesBase,
    skillsIndex: skillsBase,
    customAgents: agentsBase,
    systemMessages: 0,
    checkpointBuffer: 0,
  };

  const heavyToolCalls = [];
  let cumulativeInputTokens = 0;
  let cumulativeCachedTokens = 0;
  let cumulativeOutputTokens = 0;
  for (const idx of plannerIndices) {
    cumulativeInputTokens += (steps[idx].input_tokens || 0) + (steps[idx].cache_read_tokens || 0);
    cumulativeCachedTokens += steps[idx].cache_read_tokens || 0;
    cumulativeOutputTokens += steps[idx].output_tokens || 0;
  }

  const fixedKeys = ['rulesFiles', 'skillsIndex', 'mcpTools', 'mcpInstructions', 'customAgents', 'systemTools', 'systemPrompt'];
  const fixedBaselineSum = fixedKeys.reduce((acc, k) => acc + buckets[k], 0);
  for (const cp of checkpoints) {
    if (cp.afterTokens == null) {
      cp.afterTokens = fixedBaselineSum + cp.summaryTokens;
      cp.savedTokens = Math.max(0, cp.beforeTokens - cp.afterTokens);
    }
  }

  const lastPlannerIdx = plannerIndices.length ? plannerIndices[plannerIndices.length - 1] : -1;
  const justCompactedPendingPlanner = lastCompactionStepIdx > lastPlannerIdx;

  function attributeRawStep(st, tok, heavyCtx) {
    if (st.type === 'USER_INPUT') {
      buckets.userMessages += tok;
    } else if (st.source === 'SYSTEM' || st.type === 'SYSTEM_MESSAGE' || st.type === 'CHECKPOINT') {
      buckets.systemMessages += tok;
    } else if (st.type === 'GENERIC') {
      buckets.toolCallOutputs += tok;
      if (heavyCtx && tok > 0) {
        const tc = heavyCtx.calls[heavyCtx.offset.value];
        heavyCtx.offset.value += 1;
        if (tc) {
          const info = describeToolCallShort(tc);
          const realTarget = info.targetPath ? safeRealpath(info.targetPath) : null;
          heavyToolCalls.push({
            stepIndex: heavyCtx.stepIndex,
            toolName: tc.name || 'tool',
            label: info.label,
            path: realTarget,
            tokens: tok,
          });
        }
      }
    } else {
      buckets.systemMessages += tok;
    }
  }

  let latestCacheStats = null;

  if (justCompactedPendingPlanner) {
    // Compaction /checkpoint completed, waiting for next PLANNER_RESPONSE:
    // keep structural baseline, set checkpoint buffer and trailing post-checkpoint steps
    buckets.checkpointBuffer = lastCheckpointSummaryTokens;
    for (let j = lastCompactionStepIdx + 1; j < steps.length; j++) {
      const st = steps[j];
      attributeRawStep(st, estStepTokens(st), null);
    }
    const livePostCompactTokens = Object.values(buckets).reduce((a, b) => a + b, 0);
    const cpStep = steps[lastCompactionStepIdx];
    turnsHistory.push({
      stepIndex: cpStep.step_index ?? lastCompactionStepIdx,
      promptTokens: livePostCompactTokens,
      uncachedTokens: livePostCompactTokens,
      cachedTokens: 0,
      outputTokens: 0,
      createdAt: cpStep.created_at || null,
      compacted: true,
    });
    latestCacheStats = {
      lastPromptTokens: livePostCompactTokens,
      sinceLastCacheTokens: livePostCompactTokens,
      cachedTokens: 0,
      cacheHitRatio: 0,
      lastOutputTokens: 0,
    };
  } else if (plannerIndices.length === 0) {
    buckets.userMessages = preFirstUserEst;
    buckets.systemMessages = preFirstSysEst;
  } else {
    const anchorPos = lastCompactionStepIdx >= 0
      ? plannerIndices.findIndex((pIdx) => pIdx > lastCompactionStepIdx)
      : 0;
    const anchorStepIdx = plannerIndices[anchorPos];
    const anchorPrompt = (steps[anchorStepIdx].input_tokens || 0) + (steps[anchorStepIdx].cache_read_tokens || 0);

    if (lastCompactionStepIdx < 0) {
      buckets.userMessages = firstUserTokens;
      buckets.systemMessages = firstSysMsgTokens;
    } else {
      // After compaction: fixed baseline persists, split remainder between post-checkpoint steps and checkpointBuffer
      if (fixedBaselineSum > anchorPrompt * 0.85) {
        const s = (anchorPrompt * 0.85) / fixedBaselineSum;
        for (const k of fixedKeys) {
          buckets[k] = Math.round(buckets[k] * s);
        }
      }
      const adjustedFixed = fixedKeys.reduce((acc, k) => acc + buckets[k], 0);
      const availablePostFixed = Math.max(0, anchorPrompt - adjustedFixed);

      const postCpSteps = [];
      let postCpEstSum = 0;
      for (let j = lastCompactionStepIdx + 1; j < anchorStepIdx; j++) {
        const est = estStepTokens(steps[j]);
        postCpSteps.push({ step: steps[j], est });
        postCpEstSum += est;
      }

      const cpBufWeight = lastCheckpointSummaryTokens > 0
        ? lastCheckpointSummaryTokens
        : Math.max(0, availablePostFixed - postCpEstSum);
      const totalWeight = cpBufWeight + postCpEstSum;
      let allocatedPostCp = 0;

      if (postCpSteps.length > 0 && availablePostFixed > 0) {
        for (const item of postCpSteps) {
          const rawTok = totalWeight <= availablePostFixed
            ? Math.round(item.est)
            : (totalWeight > 0 ? Math.round((availablePostFixed * item.est) / totalWeight) : 0);
          const tok = Math.min(rawTok, Math.max(0, availablePostFixed - allocatedPostCp));
          allocatedPostCp += tok;
          attributeRawStep(item.step, tok, null);
        }
      }
      buckets.checkpointBuffer = Math.max(0, availablePostFixed - allocatedPostCp);
    }

    // Attribute turn-by-turn deltas from anchorPos + 1 to the latest planner step
    for (let k = anchorPos + 1; k < plannerIndices.length; k++) {
      const prevIdx = plannerIndices[k - 1];
      const curIdx = plannerIndices[k];
      const prevStep = steps[prevIdx];
      const curStep = steps[curIdx];
      const prevPrompt = (prevStep.input_tokens || 0) + (prevStep.cache_read_tokens || 0);
      const curPrompt = (curStep.input_tokens || 0) + (curStep.cache_read_tokens || 0);
      const delta = curPrompt - prevPrompt;
      const prevOut = prevStep.output_tokens || 0;

      // Gather intervening steps between prevIdx and curIdx
      const intervening = [];
      let estInterveningSum = 0;
      for (let j = prevIdx + 1; j < curIdx; j++) {
        const est = estStepTokens(steps[j]);
        intervening.push({ step: steps[j], est });
        estInterveningSum += est;
      }

      let actualPrevOut = 0;
      let actualIntervening = 0;

      if (delta >= prevOut) {
        actualPrevOut = prevOut;
        actualIntervening = delta - prevOut;
      } else if (delta >= 0) {
        actualIntervening = Math.min(delta, estInterveningSum);
        actualPrevOut = Math.max(0, delta - actualIntervening);
      } else {
        // Non-compaction prune (e.g., model switch dropped earlier thinking blocks)
        actualIntervening = estInterveningSum;
        let remPrune = estInterveningSum - delta; // > 0
        const takeThink = Math.min(buckets.agentThinking, remPrune);
        buckets.agentThinking -= takeThink;
        remPrune -= takeThink;
        if (remPrune > 0) {
          const takeReplies = Math.min(buckets.agentReplies, remPrune);
          buckets.agentReplies -= takeReplies;
        }
      }

      if (actualPrevOut > 0) {
        const sp = splitPlannerOutput(prevStep, actualPrevOut);
        buckets.agentReplies += sp.replies;
        buckets.agentThinking += sp.thinking;
        buckets.toolCallArgs += sp.toolArgs;
      }

      if (actualIntervening > 0 && intervening.length > 0) {
        const prevCalls = Array.isArray(prevStep.tool_calls) ? prevStep.tool_calls : [];
        const batchOffset = { value: 0 };
        let allocated = 0;

        for (let m = 0; m < intervening.length; m++) {
          const item = intervening[m];
          const tok = m === intervening.length - 1
            ? Math.max(0, actualIntervening - allocated)
            : (estInterveningSum > 0
              ? Math.round((actualIntervening * item.est) / estInterveningSum)
              : Math.round(actualIntervening / intervening.length));
          allocated += tok;
          attributeRawStep(item.step, tok, {
            calls: prevCalls,
            offset: batchOffset,
            stepIndex: prevStep.step_index ?? prevIdx,
          });
        }
      }
    }

    // Add final planner step's own output + any trailing steps not yet reflected in a newer planner step
    const lastIdx = plannerIndices[plannerIndices.length - 1];
    const lastStep = steps[lastIdx];
    const lastPrompt = (lastStep.input_tokens || 0) + (lastStep.cache_read_tokens || 0);
    const lastOut = lastStep.output_tokens || 0;
    const spLast = splitPlannerOutput(lastStep, lastOut);
    buckets.agentReplies += spLast.replies;
    buckets.agentThinking += spLast.thinking;
    buckets.toolCallArgs += spLast.toolArgs;

    let trailingTokens = 0;
    const lastCalls = Array.isArray(lastStep.tool_calls) ? lastStep.tool_calls : [];
    const trailingOffset = { value: 0 };
    for (let j = lastIdx + 1; j < steps.length; j++) {
      const st = steps[j];
      const tok = estStepTokens(st);
      trailingTokens += tok;
      attributeRawStep(st, tok, {
        calls: lastCalls,
        offset: trailingOffset,
        stepIndex: lastStep.step_index ?? lastIdx,
      });
    }

    const exactTarget = lastPrompt + lastOut + trailingTokens;
    reconcileActiveBuckets(buckets, exactTarget);
  }

  const usedTokens = Object.values(buckets).reduce((a, b) => a + b, 0);
  const freeTokens = Math.max(0, contextLimit - usedTokens);
  const usedPercent = contextLimit > 0 ? Math.min(100, (usedTokens / contextLimit) * 100) : 0;

  // Latest cache metrics
  const latestPlanner = plannerIndices.length ? steps[plannerIndices[plannerIndices.length - 1]] : null;
  const lastInputUncached = latestCacheStats
    ? latestCacheStats.sinceLastCacheTokens
    : (latestPlanner?.input_tokens || 0);
  const lastCacheRead = latestCacheStats
    ? latestCacheStats.cachedTokens
    : (latestPlanner?.cache_read_tokens || 0);
  const lastPromptTotal = latestCacheStats
    ? latestCacheStats.lastPromptTokens
    : (lastInputUncached + lastCacheRead);
  const cacheHitRatio = latestCacheStats
    ? latestCacheStats.cacheHitRatio
    : (lastPromptTotal > 0 ? lastCacheRead / lastPromptTotal : 0);
  const lastOutputTokens = latestCacheStats
    ? latestCacheStats.lastOutputTokens
    : (latestPlanner?.output_tokens || 0);

  heavyToolCalls.sort((a, b) => b.tokens - a.tokens);
  const totalToolCalls = heavyToolCalls.length;
  const topToolCalls = heavyToolCalls.slice(0, 15);

  // Build safe file:// map for all clickable resources
  const rawPaths = [
    ...customizations.rules.map((r) => r.path),
    ...customizations.skills.map((s) => s.path),
    ...customizations.customAgents.map((a) => a.path),
    ...customizations.mcpServers.flatMap((m) => [m.instructionsPath, ...m.tools.map((t) => t.path)]),
    ...artifacts.map((a) => a.path),
    ...topToolCalls.map((t) => t.path),
  ].filter(Boolean);

  const allowedRoots = buildAllowedRoots(appData, workspaceUris, rawPaths);
  const allowedFiles = {};
  for (const p of rawPaths) {
    if (!Object.hasOwn(allowedFiles, p)) {
      const uri = canonicalAllowedFile(p, allowedRoots);
      if (uri) allowedFiles[p] = uri;
    }
  }

  const toolCallsTotal = buckets.toolCallArgs + buckets.toolCallOutputs;
  const agentResponsesTotal = buckets.agentReplies + buckets.agentThinking;
  const sessionCacheHitRatio = cumulativeInputTokens > 0
    ? Number(((cumulativeCachedTokens / cumulativeInputTokens) * 100).toFixed(1))
    : 0;

  return {
    conversationId: convId,
    found: true,
    exact: plannerIndices.length > 0 && !justCompactedPendingPlanner,
    model: {
      id: modelInfo.modelId,
      label: modelInfo.modelLabel,
    },
    contextLimit,
    modelMaxTokens: modelInfo.modelMaxTokens || contextLimit,
    limitSource: modelInfo.limitSource || 'antigravity',
    usedTokens,
    freeTokens,
    usedPercent: Number(usedPercent.toFixed(1)),
    stepCount: steps.length,
    plannerTurnCount: plannerIndices.length,
    lastStepAt: steps.length ? steps[steps.length - 1].created_at || null : null,
    cache: {
      lastPromptTokens: lastPromptTotal,
      sinceLastCacheTokens: lastInputUncached,
      cachedTokens: lastCacheRead,
      cacheHitRatio: Number((cacheHitRatio * 100).toFixed(1)),
      lastOutputTokens,
      cumulativeInputTokens,
      cumulativeCachedTokens,
      sessionCacheHitRatio,
      cumulativeOutputTokens,
    },
    compaction: {
      count: checkpoints.length,
      totalSavedTokens: checkpoints.reduce((a, c) => a + c.savedTokens, 0),
      checkpoints,
    },
    categories: {
      messages: buckets.userMessages,
      agentResponses: agentResponsesTotal,
      agentReplies: buckets.agentReplies,
      agentThinking: buckets.agentThinking,
      toolCalls: toolCallsTotal,
      toolCallOutputs: buckets.toolCallOutputs,
      toolCallArgs: buckets.toolCallArgs,
      mcpTools: buckets.mcpTools,
      mcpInstructions: buckets.mcpInstructions,
      systemTools: buckets.systemTools,
      systemPrompt: buckets.systemPrompt,
      rulesFiles: buckets.rulesFiles,
      skills: buckets.skillsIndex,
      customAgents: buckets.customAgents,
      systemMessages: buckets.systemMessages,
      checkpointBuffer: buckets.checkpointBuffer,
      sinceLastCache: lastInputUncached,
      freeSpace: freeTokens,
      mcpDeferred: customizations.mcpDeferredTokens,
      skillsDeferred: customizations.deferredSkillsTokens,
      rulesDeferred: customizations.deferredRulesTokens,
    },
    details: {
      totalToolCalls,
      heavyToolCalls: topToolCalls,
      mcpServers: customizations.mcpServers,
      totalMcpTools: customizations.totalMcpTools,
      rules: customizations.rules,
      skills: customizations.skills,
      customAgents: customizations.customAgents,
      spawnedSubagents,
      artifacts,
      turnsHistory,
      plugins: customizations.plugins,
    },
    allowedFiles,
    transcriptStats: {
      path: activeTranscriptPath,
      mtime: transcriptMtime,
      size: transcriptSize,
    },
  };
}
