# dsh-session-dm

给 **DSH（DeepSeek Harness）** 的智能体加上跨会话能力：**往另一个会话发消息**，或**直接开一个新的顶层对话**，全程在同一个工作区里。

DSH 自带的会话能力是只读的——`session_search` / `session_event_read` 能看别的会话，`send_message` 只能到自己的子智能体树。缺的正是**顶层会话之间的写方向**，这个插件补的就是它。

| 工具 | 作用 |
|---|---|
| `session_dm_send` | 往同一工作区的另一个会话投递一条文本。目标没在跑 → 被这条消息唤醒；在跑 → 下一轮接住。 |
| `session_create` | 在调用方工作区开一个**新的顶层会话**（真·新对话，不是子智能体），并带上首轮提示词。可指定标题。 |

两个工具返回的都是「**已受理**」回执，不是对方的回答——要读回复，用内建的 `session_search` / `session_event_read`。

[![npm](https://img.shields.io/npm/v/dsh-session-dm)](https://www.npmjs.com/package/dsh-session-dm)
[![license](https://img.shields.io/npm/l/dsh-session-dm)](./LICENSE)
[![release](https://img.shields.io/github/v/release/Venshell/dsh-session-dm)](https://github.com/Venshell/dsh-session-dm/releases)

```
会话 A                                     会话 B
   │ session_dm_send({ session_id, message })
   ▼
sessionController.resolveAgent(B)   ← 冷会话在这里被唤醒
   ├─ agent.followup(消息)          ← 进持久化 next-turn 收件箱
   └─ sessions.flush(session)       ← 等持久化确认才回执
   ▼
会话 B 把这条当普通用户输入处理，产出可用 session_search 读回
```

---

## 安装

### 方式一：从 npm 装（最简单）

```powershell
dsh plugin --profile <你的 profile> add dsh-session-dm
```

### 方式二：从本仓库装

```powershell
dsh plugin --profile <你的 profile> add github:Venshell/dsh-session-dm
```

### 方式三：从 Release 附件装

去 [Releases](https://github.com/Venshell/dsh-session-dm/releases) 下 `dsh-session-dm-0.2.0.tgz`：

```powershell
dsh plugin --profile <你的 profile> add <下载路径>\dsh-session-dm-0.2.0.tgz
```

### 方式四：从源码目录装

```powershell
git clone https://github.com/Venshell/dsh-session-dm
dsh plugin --profile <你的 profile> add <克隆路径>\dsh-session-dm
```

> ⚠️ 装完**必须重启 Harness**。宿主在启动时加载插件模块，新装或改过的代码只对重启后的会话生效。

> ⚠️ 某些 `dsh plugin add` 版本会把 profile 的 bundle 列表重写成只剩新装的那个。装完扫一眼 `dsh.profile.bundles` 是否还完整。

---

## bundle 会自动启用哪些组件

DSH 的 profile 是**分层叠加**的：出厂默认层 → 各 bundle 的 patch 层（按 `dsh.profile.bundles` 顺序）→ 你自己 profile 的 `cordis.patch.yml` → `--patch` 覆盖层。本插件的 patch 利用这个机制，**装完即把跨会话需要的组件全部打开**，包括那些出厂被关掉或压根没有的：

| 组件 | 出厂状态 | 本 bundle 做什么 |
|---|---|---|
| `dsh-session-dm` | 不存在 | `insert` 到 host plane：**所有 preset** 的会话都看得到这两个工具 |
| `@deepseek-ai/dsh-tool-session-query` | **不存在**——可选包，任何默认层都没有 | `insert`（常规 id `tool-session-query`）：挂上五个读回工具 `session_search` / `session_event_search` / `session_trace` / `session_event_trace` / `session_event_read`，否则模型只能发、读不回来 |
| `@deepseek-ai/dsh-session-query-sqlite` | 每层都有，但**搜索是关的**（`openAt: never`：服务在，只支持精确读；内容搜索会答 `SESSION_QUERY_SEARCH_DISABLED`） | id 定向覆盖（幂等——这行到处都在）：`openAt: first-search` + 持久化路径 `<home>/cache/session-search.db`，首次搜索才打开 SQLite |

两点要说清：

- **打开搜索是 profile 级的副作用。** 覆盖 `openAt` 之后，SQLite FTS **内容搜索整个 profile 都开了**，不只是本插件——侧边栏搜索也会跟着变。这是官方文档给的部署级开关；不想要就从 bundle 的 `cordis.patch.yml` 里删掉 `session-query-sqlite` 那一条。没有它两个工具照样能投递（回执读标题，`openAt: never` 下可用），只是模型搜不了历史。
- **loader 不会给 insert 去重。** 如果你的 profile 层里已经自己插了 `tool-session-query` 行（在本 bundle 出现之前手改过 profile 的人常见），删掉其中一个——挂两次会重复注册五个工具。profile 层对自己 id 的 override 不会和 bundle 冲突：后层胜出，所以你改的 `openAt` / `path` 优先。

`session_dm_send` / `session_create` 另外消费的宿主服务（`sessionController`、`sessions`、`systemPrompt`、`tools`，以及回执标题用的 `sessionQuery`）任何部署都自带，无需启用。

---

## 工作原理

插件不起后台进程、不存状态、不加 schema，全部走宿主自己的会话机制：

**消息投递**用的是内建 schedule 服务给「原会话提醒」投递时的同一套：

```
ctx.sessionController.resolveAgent(target)   // 活的 Agent，或冷唤醒
  -> agent.followup(userMessage)              // 持久化 next-turn 收件箱
  -> ctx.sessions.flush(agent.session)        // 等持久化确认
```

**会话创建**驱动的是 Web UI「新对话」按钮背后的同一个宿主 API（`sessionController.create`）。请求优先用 `workspaceId` 形式，好让新会话落进调用方所在的 UI 工作区分组而不是「未分组」；匹配不到工作区时退回裸 `{ cwd }`。两者严格互斥——宿主会拒掉同时给 `workspaceId` 和 `cwd` 的请求。

**授权边界**：只有当目标会话的 `cwd` 与调用方**完全一致**时才能发消息（沿用 `session-query` 的保守规则）。没有工作区的会话既不能发消息也不能建会话。`session_create` 永远在调用方自己的工作区里创建——**不接受**目标参数。

**可追溯**：每条投递的用户消息都带 `source: { kind: "session-dm", fromSessionId }`，从目标会话的事件日志里能反查是谁发的。

模块**零依赖**：除 `node:crypto` 外不 import 任何东西，所有宿主能力都通过注入的 Cordis 上下文拿到（`tools`、`systemPrompt`、`sessionQuery`、`sessionController`、`sessions`）。

---

## 踩过的坑（照抄前必读）

这几条都是真金白银的调试时间换来的。

### 1. 裸注册工具必须写完整 JSON Schema

本插件为了零依赖，刻意绕开了宿主的 `defineTool` 辅助函数。那个函数平时负责把简写参数（`{ field: { type, required: true } }`）转成 JSON Schema。裸注册时**没人做这层转换**，简写会被原样发布：模型侧看到每个参数类型都是 `object`，宿主按这份错 schema 校验时把字符串实参全剥掉，`execute` 永远收到 `{}`。

所以只要绕开 `defineTool`，`parameters` 就必须是完整 JSON Schema：`type: 'object'` + `properties` + `required` + `additionalProperties: false`。

### 2. `sessionController` 有两张脸

注入的 `SessionController` 服务暴露的是 `create({ cwd }) -> { sessionId }` 和 `rename({ sessionId, title })`。它内部的 `this.agents`（`ApiSessionAgentController`）暴露的是 `createSession({ cwd }) -> { agent }`。**名字像、形状不一样**。调用前先把注入服务自己的方法表从宿主 bundle 里挖出来看。

### 3. 工作区归属要 `workspaceId`，且与 `cwd` 互斥

只用 `{ cwd }` 创建能成功，但会跳过 `workspace.attachSession`，于是会话在 UI 里显示成**未分组**。同时传 `workspaceId` 和 `cwd` 是硬错误（"accepts workspaceId or cwd, not both"）。

### 4. ESM 缓存不会因为改文件而失效

profile 里装的这个插件是指向仓库目录的符号链接，所以源码一改磁盘上立刻生效——但**运行中的宿主还握着旧模块**。每次改动都要重启 Harness。

### 5. loader 的 patch 语义（写 patch 前必须知道）

从宿主 bundle 里扒出来的 `applyEntryPatches`：

- `insert` **无条件追加**，不去重；只是把新行加进索引，让**同一个 patch 列表里靠后的 patch** 能定位到它。
- id 定向 patch（有 `id` 无 `insert`）替换指定字段，`config` 是**整体替换**不做深合并；目标行不存在就警告 + 跳过。
- profile 层叠在 bundle 层之后，所以**后层胜出**。

---

## 兼容性

在 DeepSeek Harness 0.2.x 桌面版 profile（Windows）上开发和验证。它摸的宿主接口（`sessionController.create` / `resolveAgent` / `rename`、`agent.followup`、`sessions.flush`、`workspaceRegistry.list`）都是内部缝隙，跨版本可能变——真变了代码会**大声失败**而不是静默降级。

---

## 文件地图

| 文件 | 作用 |
|---|---|
| `index.js` | 全部逻辑：两个工具 + 系统提示段落，零依赖 |
| `cordis.patch.yml` | host-plane 插入行 + 读回工具与内容搜索的启用（见上文「bundle 会自动启用哪些组件」） |
| `package.json` | bundle 清单（`dsh.bundle.patch`）、`exports`、`files` 白名单 |
| `locale/en.json`、`locale/zh.json` | 插件管理器里的标题与描述 |
| `icon.svg` | 原创图标（两个节点 + 递送箭头） |
| `LICENSE` | GPL-3.0 |

---

## 开发

```powershell
# 语法检查
node --check index.js

# 看实际会打进包里的文件（files 不过滤本地链接目录，必须从 tarball 里核对）
npm pack --dry-run

# 本地验证工具注册（不需要宿主）
node --input-type=module -e "const m = await import('./index.js'); const regs=[]; m.apply({systemPrompt:{section:()=>{},getSectionOrder:()=>0},tools:{register:t=>regs.push(t)}}); console.log(regs.map(r=>r.name))"
```

改完 → 重启 Harness → 在新会话里验证工具真的出现且能带参调用。

---

## English

**Cross-session tools for DeepSeek Harness** — let one agent Session message another, or start a fresh top-level conversation, inside the same workspace.

DeepSeek Harness ships read-only seams for cross-session work: `session_search` / `session_event_read` can look into other Sessions, and `send_message` reaches only a caller's own subagent tree. The missing direction is writing between **top-level** Sessions — this plugin adds it.

| Tool | What it does |
|---|---|
| `session_dm_send` | Deliver a text message into another Session of the same workspace. A cold target is resumed by the message; a live one picks it up next turn. |
| `session_create` | Start a NEW top-level Session (a fresh conversation, never a subagent) in the caller's workspace and deliver a first prompt to it. Optional title. |

Both return a receipt confirming **acceptance, not a reply** — read the other Session's answer back with the built-in `session_search` / `session_event_read`.

### Install

```powershell
dsh plugin --profile <your-profile> add dsh-session-dm
# or: github:Venshell/dsh-session-dm / a release tarball / a cloned directory
```

Restart the Harness afterward — plugin modules load at boot.

### What the bundle enables for you

A profile is a stack of layers: shipped defaults, then bundle patches, then your own `cordis.patch.yml`. This plugin's patch uses that to turn on everything cross-session work needs, including components that ship disabled or absent:

- **`@deepseek-ai/dsh-tool-session-query`** — inserted at the host plane. This opt-in package ships in no default layer; without it the two tools deliver but the model cannot read replies back. Provides `session_search`, `session_event_search`, `session_trace`, `session_event_trace`, `session_event_read`.
- **`@deepseek-ai/dsh-session-query-sqlite`** — overridden from `openAt: never` (content search closed) to `openAt: first-search` with a durable index under `<home>/cache/session-search.db`. Note this opens content search **profile-wide**; delete that patch entry to keep it off.

The loader does not dedupe inserts: if your profile layer already inserts its own `tool-session-query` row, remove one to avoid a double mount. Profile-layer overrides still win over the bundle's (later layers win).

### How it works

Message delivery is the routine the built-in schedule service uses for original-Session reminders:

```
ctx.sessionController.resolveAgent(target)   // live Agent, or cold resume
  -> agent.followup(userMessage)              // durable next-turn inbox
  -> ctx.sessions.flush(agent.session)        // acknowledged persistence
```

Session creation drives the same host API the Web UI "new conversation" button drives (`sessionController.create`), preferring the `workspaceId` form so the new Session lands in the caller's UI group; `workspaceId` and `cwd` are mutually exclusive.

Authority: a sender may address a Session only when the target's `cwd` exactly equals the caller's. A Session without a workspace may neither message others nor create Sessions. Every delivered message carries `source: { kind: "session-dm", fromSessionId }` for traceability.

Zero dependencies — the only import is `node:crypto`.

### Sharp edges

1. **Bare registration needs a complete JSON Schema.** Skipping the host's `defineTool` means nothing converts a shorthand parameter spec; the shorthand is published as-is, every parameter reports as `object`, the host strips the mismatched arguments, and `execute` always receives `{}`. Write `type: 'object'` + `properties` + `required` + `additionalProperties: false`.
2. **`sessionController` has two faces.** The injected service exposes `create({ cwd }) -> { sessionId }` and `rename({ sessionId, title })`; its internal `this.agents` exposes `createSession({ cwd }) -> { agent }`. Similar names, different shapes.
3. **Workspace attachment needs `workspaceId`, exclusively with `cwd`.** A bare `{ cwd }` mint skips `workspace.attachSession` and shows up ungrouped; passing both is a hard error.
4. **ESM cache survives file edits.** The profile install is a symlink to the checkout, but the running host keeps the old module — every change needs a restart.
5. **Loader patch semantics.** `insert` appends unconditionally (no dedupe, indexed for later patches in the same list); id-targeted patches replace named fields wholesale and are skipped with a warning when the target is missing; later layers win.

### Compatibility

Developed and tested against a DeepSeek Harness 0.2.x desktop profile (Windows). The host seams it touches are internal and may shift between versions — the code fails loudly rather than silently when they do.

---

## 许可 / License

[GPL-3.0](./LICENSE) © 2026 Venshell

### 出处 / Provenance

| 参考对象 | 参考了什么 | 许可证 |
|---|---|---|
| DSH 宿主 bundle（`app.asar`） | 通过字节扫描反解出的**宿主内部契约**：`applyEntryPatches` 的 patch 语义、`sessionController` 的方法表与返回形状、出厂 profile 层的组件默认状态 | 宿主自身许可；本插件为**独立实现**，无代码复制 |
| [dsh-zcode-startplan](https://github.com/Venshell/dsh-zcode-startplan) | README 的**组织形态**（徽章、中文主体、许可表），同作者自己的包 | GPL-3.0 |
