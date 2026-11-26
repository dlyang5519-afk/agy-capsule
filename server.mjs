/**
 * Multi-Layer Local Telemetry Bridge for Antigravity Context Capsule.
 * - Automatically detects all active root projects (nesting_depth = 0, subagents excluded)
 * - Per-conversation incremental caching: only re-analyzes transcripts whose mtime/size changed
 * - Reads tail of transcript.jsonl + SQLite WAL mtime to distinguish AI "Running" vs "Waiting for User" accurately
 * - Preserves stable vertical layer ordering so rows never jump around
 * - Supports per-layer dismiss (/dismiss?id=...) that auto-revives on new activity
 */

import http from 'node:http';
import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  analyzeConversation,
  findAppDataDirs,
  listRecentConversations,
  resolveConversationAppData,
} from './lib/analyzer.mjs';

let activeWindowMin = 60; // Optimized default: 1 hour (aligns with cold-cache horizon & avoids stale clutter)
const MAX_LAYERS = 8;
const RUNNING_STALE_LIMIT_SEC = 330; // 5m30s: covers 99.85% of long novel chapter streaming & external CLI tool steps

const convSnapCache = new Map(); // convId -> { key, data }
const dismissedMap = new Map();  // convId -> dismissedAtMtimeMs
const orderMap = new Map();      // convId -> stable integer slot
let nextOrderSeq = 1;

let latestPayload = {
  items: [],
  activeWindowMin,
  hiddenCount: 0,
  nowMs: Date.now(),
};
let refreshing = false;

function shortModelName(model) {
  const raw = (model?.id || model?.label || '').toLowerCase();
  if (!raw) return 'AI';
  if (raw.includes('carbon')) return 'Carbon';
  if (raw.includes('hydrogen')) return 'H';
  if (raw.includes('neon')) return 'Neon';
  if (raw.includes('argon')) return 'Argon';
  if (raw.includes('flash')) return 'Flash';
  if (raw.includes('opus')) return 'Opus';
  if (raw.includes('sonnet')) return 'Sonnet';
  if (raw.includes('haiku')) return 'Haiku';
  if (raw.includes('gpt')) return 'GPT';
  return model?.label?.split(' ').slice(-1)[0] || 'AI';
}

function isLowCostModel(model) {
  const raw = (model?.id || model?.label || '').toLowerCase();
  return (
    raw.includes('hydrogen') ||
    raw.includes('flash') ||
    raw.includes('haiku') ||
    raw.includes('gpt-oss')
  );
}

function readSummariesMeta() {
  const metaMap = new Map();
  const appDirs = findAppDataDirs();
  const candidates = appDirs.length > 0
    ? appDirs.map((d) => join(d, 'conversation_summaries.db'))
    : [join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db')];

  for (const dbPath of candidates) {
    if (!existsSync(dbPath)) continue;
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare(
        'SELECT conversation_id, title, nesting_depth, last_modified_time FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 60'
      ).all();
      for (const r of rows) {
        if (!metaMap.has(r.conversation_id)) {
          metaMap.set(r.conversation_id, {
            title: (r.title || '').trim(),
            nestingDepth: Number(r.nesting_depth || 0),
            lastModified: r.last_modified_time || '',
          });
        }
      }
    } catch {
      // ignore transient sqlite lock
    } finally {
      try { db?.close(); } catch {}
    }
  }
  return metaMap;
}

function readTailSteps(appData, convId) {
  const p = `${appData.replace(/\\/g, '/')}/brain/${convId}/.system_generated/logs/transcript.jsonl`;
  if (!existsSync(p)) return [];
  let fd = null;
  try {
    fd = openSync(p, 'r');
    const st = fstatSync(fd);
    if (st.size <= 0) return [];
    const len = Math.min(st.size, 262144); // last 256KB of compact transcript
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    const startIdx = st.size > len ? 1 : 0;
    const out = [];
    for (let i = startIdx; i < lines.length; i++) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj && typeof obj === 'object') out.push(obj);
      } catch {}
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
  }
}

function getLiveStorageMtimeMs(appData, convId, transcriptMtimeMs) {
  let latest = transcriptMtimeMs;
  const base = `${appData.replace(/\\/g, '/')}/conversations/${convId}.db`;
  for (const candidate of [base, `${base}-wal`]) {
    try {
      if (existsSync(candidate)) {
        const st = statSync(candidate);
        if (st.mtimeMs > latest) latest = st.mtimeMs;
      }
    } catch {}
  }
  return latest;
}

function inspectRunState(appData, convId, transcriptMtimeMs) {
  const tail = readTailSteps(appData, convId);
  const lastStep = tail.at(-1) || null;

  // Locate start of current active run (most recent USER_INPUT, or first step after CHECKPOINT)
  let runAnchorMs = NaN;
  for (let i = tail.length - 1; i >= 0; i--) {
    const s = tail[i];
    if (s.type === 'USER_INPUT') {
      const t = s.created_at ? Date.parse(s.created_at) : NaN;
      if (Number.isFinite(t)) runAnchorMs = t;
      break;
    }
    if (s.type === 'CHECKPOINT') {
      const nextAfterCp = tail[i + 1];
      const t = nextAfterCp?.created_at
        ? Date.parse(nextAfterCp.created_at)
        : (s.created_at ? Date.parse(s.created_at) : NaN);
      if (Number.isFinite(t)) runAnchorMs = t;
      break;
    }
  }

  const hasTools = !!(
    lastStep?.type === 'PLANNER_RESPONSE' &&
    Array.isArray(lastStep.tool_calls) &&
    lastStep.tool_calls.length > 0
  );
  const isAskUser = hasTools && lastStep.tool_calls.some((t) => t?.name === 'ask_question');

  const terminalIdle =
    !lastStep ||
    lastStep.status === 'CANCELED' ||
    lastStep.status === 'ERROR' ||
    lastStep.type === 'CHECKPOINT' ||
    (lastStep.type === 'PLANNER_RESPONSE' && lastStep.status === 'DONE' && (!hasTools || isAskUser));

  let isRunning = false;
  if (!terminalIdle) {
    const liveMtimeMs = getLiveStorageMtimeMs(appData, convId, transcriptMtimeMs);
    const liveAgeSec = (Date.now() - liveMtimeMs) / 1000;
    isRunning = liveAgeSec < RUNNING_STALE_LIMIT_SEC;
  }

  const runStartMs = Number.isFinite(runAnchorMs) ? runAnchorMs : transcriptMtimeMs;

  return {
    isRunning,
    isAskUser,
    runStartMs: Math.round(runStartMs),
  };
}

async function getProjectSnapshot(target, metaMap) {
  const meta = metaMap.get(target.id);
  const rawTitle = (meta?.title || '').replace(/\s+/g, ' ').trim() || `新对话 ${target.id.slice(0, 6)}`;
  const key = `${target.id}|${target.mtime}|${target.size}|${rawTitle}`;

  const appData = resolveConversationAppData(target.id);
  if (!appData) return null;

  let base = convSnapCache.get(target.id);
  if (!base || base.key !== key) {
    const snap = await analyzeConversation(appData, target.id, { workspaceUris: [] });
    if (!snap || !snap.found) return null;

    const usedTokens = snap.usedTokens || 0;
    const contextLimit = snap.contextLimit || 512000;
    const pct = contextLimit > 0 ? Math.min(100, +(usedTokens / contextLimit * 100).toFixed(1)) : 0;
    const transcriptMtimeMs = Math.round(snap.transcriptStats?.mtime || target.mtime || Date.now());

    base = {
      key,
      data: {
        conversationId: target.id,
        title: rawTitle,
        displayTitle: rawTitle.length > 11 ? rawTitle.slice(0, 11) + '…' : rawTitle,
        modelId: snap.model?.id || '',
        modelLabel: snap.model?.label || 'Unknown',
        modelShort: shortModelName(snap.model),
        isCheapModel: isLowCostModel(snap.model),
        usedTokens,
        contextLimit,
        pct,
        lastHitRatio: snap.cache?.cacheHitRatio ?? null,
        sessionHitRatio: snap.cache?.sessionCacheHitRatio ?? null,
        compactionCount: snap.compaction?.count || 0,
        lastActivityMs: transcriptMtimeMs,
      },
    };
    convSnapCache.set(target.id, base);
  }

  // Always compute fresh isRunning state (checks live transcript/WAL mtime against 330s threshold)
  const runInfo = inspectRunState(appData, target.id, base.data.lastActivityMs);
  return {
    ...base.data,
    ...runInfo,
  };
}

async function refreshSnapshot() {
  if (refreshing) return;
  refreshing = true;
  try {
    const now = Date.now();
    const recentRaw = listRecentConversations(25) || [];
    const metaMap = readSummariesMeta();

    // Keep only root conversations (exclude subagents with nestingDepth > 0)
    const rootConvs = recentRaw.filter((c) => {
      const m = metaMap.get(c.id);
      return !m || m.nestingDepth === 0;
    });

    const windowMs = activeWindowMin * 60 * 1000;
    let candidates = rootConvs.filter((c) => (now - c.mtime) <= windowMs);

    // Fallback: if nothing active in window, show the single most recent non-dismissed root project
    if (candidates.length === 0 && rootConvs.length > 0) {
      const fallback = rootConvs.find((c) => {
        const disMs = dismissedMap.get(c.id);
        return disMs === undefined || c.mtime > disMs + 500;
      });
      if (fallback) candidates = [fallback];
    }

    // Filter out manually dismissed layers unless they had new activity after dismissal
    let hiddenCount = 0;
    const visibleConvs = [];
    for (const c of candidates) {
      const disMs = dismissedMap.get(c.id);
      if (disMs !== undefined && c.mtime <= disMs + 500) {
        hiddenCount++;
        continue;
      }
      if (disMs !== undefined && c.mtime > disMs + 500) {
        dismissedMap.delete(c.id);
      }
      visibleConvs.push(c);
      if (visibleConvs.length >= MAX_LAYERS) break;
    }

    // Assign stable vertical slot order (oldest-registered stays in its slot so rows never jump)
    for (const c of [...visibleConvs].reverse()) {
      if (!orderMap.has(c.id)) {
        orderMap.set(c.id, nextOrderSeq++);
      }
    }

    visibleConvs.sort((a, b) => (orderMap.get(a.id) || 0) - (orderMap.get(b.id) || 0));

    const items = [];
    for (const c of visibleConvs) {
      const item = await getProjectSnapshot(c, metaMap);
      if (item) items.push(item);
    }

    latestPayload = {
      items,
      activeWindowMin,
      hiddenCount,
      nowMs: Date.now(),
    };
  } catch {
    // retain previous snapshot on transient error
  } finally {
    refreshing = false;
  }
}

await refreshSnapshot();
setInterval(refreshSnapshot, 1500);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');

  if (url.pathname === '/state') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ ...latestPayload, nowMs: Date.now() }));
    return;
  }

  if (url.pathname === '/dismiss') {
    const id = (url.searchParams.get('id') || '').trim();
    if (id) {
      const cached = convSnapCache.get(id);
      const mtime = cached?.data?.lastActivityMs || Date.now();
      dismissedMap.set(id, mtime);
      await refreshSnapshot();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ...latestPayload, nowMs: Date.now() }));
    return;
  }

  if (url.pathname === '/restore') {
    dismissedMap.clear();
    await refreshSnapshot();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ...latestPayload, nowMs: Date.now() }));
    return;
  }

  if (url.pathname === '/window') {
    const min = Number(url.searchParams.get('min') || 60);
    if (Number.isFinite(min) && min >= 15 && min <= 2880) {
      activeWindowMin = min;
      await refreshSnapshot();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ...latestPayload, nowMs: Date.now() }));
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  process.stdout.write(`PORT=${addr.port}\n`);
});
