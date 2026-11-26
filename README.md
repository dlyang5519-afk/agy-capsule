# 反重力缓存胶囊 / 反重力上下文胶囊 (`agy-capsule`)

> 🔍 **GitHub 中文直搜暗号**：`反重力缓存胶囊` · `反重力上下文胶囊` · `反重力悬浮胶囊`

专为 Google Antigravity（反重力）打造的 **Windows 桌面置顶多层上下文 & 4 分钟缓存倒计时悬浮栈**。  
**100% 独立运行**，无需在 Antigravity 内安装任何插件（无需安装上下文或用量插件），开箱即用。

## ✨ 核心功能

- **多项目自动分层**：自动识别当前活跃的主对话（自动过滤后台 Subagent 子代理），多层垂直对齐不跳行。
- **运行态 vs 缓存倒计时精准区分**：
  - `⚡ mm:ss`：AI 正在思考、流式输出长文或执行工具，显示本轮已运行时长。
  - `⏱ 04:00`：AI 已回复完毕等待用户输入，开启 **4 分钟黄金高命中缓存倒计时**。
  - **剩余 45 秒琥珀色闪烁提醒**：高上下文（默认 `≥100K`）即将跨过缓存衰减拐点时温和提醒保活或趁热 `/compact`。
  - **已凉智能压缩建议**：闲置超过 `25–30` 分钟进入冷缓存区后，根据当前模型成本自动提示「`切H压缩`」或「`直接压缩`」，大幅节省订阅额度。
- **双屏 / `Win+D` 防丢与一键召唤**：支持多显示器 DPI 自适应、`Win+D` 显示桌面后自动置顶恢复；随时双击桌面快捷方式即可将悬浮窗召唤至鼠标所在屏幕并恢复隐藏层。
- **跟随启停**：支持在 `Antigravity.exe` 完全关闭后自动退出后台进程，零残留。
- **右键个性化菜单**：支持深色/浅色毛玻璃主题、透明度、提示音开关、高下文提醒档位（`50K / 100K / 180K`）及活跃时间窗口切换。

---

## 🖥️ 环境要求

- **操作系统**：Windows 10 / Windows 11（内置 PowerShell 5.1 + WPF，无需额外运行库）
- **Node.js**：**v22.5 及以上版本**（使用 Node.js 原生内置的 `node:sqlite` 只读解析本地元数据，**零 `npm install` 第三方依赖**）

---

## 🚀 新电脑快速使用（免登录一键下载）

### 方式一：直接下载 ZIP（最省事）
1. 点击本仓库右上角的绿色 **`Code` -> `Download ZIP`**，解压到任意固定目录（例如 `D:\Tools\agy-capsule`）。
2. 双击文件夹内的 **`创建桌面快捷方式.vbs`**（会在桌面生成「启动上下文胶囊」图标并自动启动）。
3. 之后随时双击 **`启动上下文胶囊.vbs`**（或桌面快捷方式）即可启动 / 召唤悬浮窗。

### 方式二：Git 克隆更新
```powershell
git clone https://github.com/dlyang5519-afk/agy-capsule.git
cd agy-capsule
wscript.exe 创建桌面快捷方式.vbs
```

---

## ⚙️ 可选：跟随 Antigravity 自动启动

如果你用自定义启动脚本打开 Antigravity，只需在启动脚本里顺带执行一行（不会重复多开）：

```vbscript
CreateObject("WScript.Shell").Run """D:\你的路径\agy-capsule\launch.vbs"" --auto", 0, False
```

---

## 📄 开源协议

本项目基于 [MIT License](./LICENSE) 开源。其中 `lib/analyzer.mjs` 源自 `agy-context`（Copyright (c) 2026 Ahmet Sahin, MIT License），仅在本地只读解析 `~/.gemini/antigravity` 日志，不上传任何数据。
