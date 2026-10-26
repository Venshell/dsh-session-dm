# dsh-session-dm

Cross-session tools for [DeepSeek Harness](https://github.com/deepseek-ai) — let one agent Session **message another** or **start a fresh top-level Session**, all inside the same workspace.

DeepSeek Harness ships read-only seams for cross-session work: `session_search` / `session_event_read` can look into other Sessions, and `send_message` can reach a caller's own subagent tree. What it does not ship is a write direction between **top-level** Sessions. This plugin adds exactly that, as two model-facing tools:

| Tool | What it does |
|---|---|
| `session_dm_send` | Deliver a text message into another Session of the same workspace. A cold target is resumed by the message; a live one picks it up next turn. |
| `session_create` | Start a NEW top-level Session (a fresh conversation, never a subagent) in the caller's workspace and deliver a first prompt to it. |

Both tools return a delivery receipt confirming **acceptance, not a reply** — the model reads the other Session's answer back later with the built-in `session_search` / `session_event_read`.

## How it works

The plugin registers no background processes, keeps no store, and adds no schema. Everything rides the Host's own session machinery:

- **Message delivery** is the same routine the built-in schedule service uses for original-Session reminders:

  ```
  ctx.sessionController.resolveAgent(target)   // live Agent, or cold resume
    -> agent.followup(userMessage)              // durable next-turn inbox
    -> ctx.sessions.flush(agent.session)        // acknowledged persistence
  ```

- **Session creation** drives the same host API the Web UI "new conversation" button drives (`sessionController.create`). The request prefers the `workspaceId` form so the new Session lands in the caller's UI workspace group instead of ungrouped; it falls back to a bare `{ cwd }` mint when no workspace matches. The request is strictly `workspaceId` XOR `cwd` — the host rejects both.

- **Workspace authority**: a sender may address a Session only when the target's `cwd` exactly equals the caller's (the conservative rule `session-query` uses). A Session without a workspace may neither message others nor create Sessions. `session_create` always creates in the caller's own workspace — it accepts no destination parameter.

- **Traceability**: every delivered user message carries `source: { kind: "session-dm", fromSessionId }`, so a sender stays recoverable from the target's event log.

The module is **zero-dependency**: it imports nothing beyond `node:crypto`, and every host capability arrives through the Cordis context it injects (`tools`, `systemPrompt`, `sessionQuery`, `sessionController`, `sessions`).

## Install

From a checkout of this repository, into a running profile:

```powershell
dsh plugin --profile <your-profile> add <path-to-this-repo>
```

or install directly from GitHub (if published):

```powershell
dsh plugin --profile <your-profile> add github:<owner>/dsh-session-dm
```

Then **restart the Harness** — the host loads plugin modules at boot, so new tools and edited code only appear in sessions started after a restart.

> ⚠️ Some `dsh plugin add` versions rewrite the profile's bundle list to just the newly added bundle. After installing, check your profile's `dsh.profile.bundles` still lists everything you had.

## The sharp edges (learned the hard way)

These cost real debugging time; read them before writing your own bare-registration plugin.

1. **Bare tool registration requires a complete JSON Schema.** This plugin deliberately skips the host's `defineTool` helper to stay zero-dependency. That helper normally converts a shorthand parameter spec (`{ field: { type, required: true } }`) into JSON Schema. Registered raw, a shorthand is published as-is: the model sees every parameter typed `object`, the host strips the mismatched string arguments during validation, and `execute` always receives `{}`. Always write `parameters` as a full JSON Schema (`type: 'object'` + `properties` + `required` + `additionalProperties: false`) when bypassing `defineTool`.

2. **`sessionController` has two faces.** The injected `SessionController` service exposes `create({ cwd }) -> { sessionId }` and `rename({ sessionId, title })`. Its internal `this.agents` (`ApiSessionAgentController`) exposes `createSession({ cwd }) -> { agent }`. The names look interchangeable; the shapes are not. Dig the injected service's own method table out of the host bundle before calling it.

3. **Workspace attachment needs `workspaceId`, and it is exclusive with `cwd`.** Creating with only `{ cwd }` succeeds but skips `workspace.attachSession`, so the Session shows up **ungrouped** in the UI. Passing both `workspaceId` and `cwd` is a hard error ("accepts workspaceId or cwd, not both").

4. **ESM cache survives file edits.** The profile install of this plugin is a symlink to the workspace checkout, so source edits land immediately on disk — but the running host keeps the old module in memory. Every change needs a Harness restart to take effect.

## Layout

```
dsh-session-dm/
├── index.js          # the whole plugin: two tools + system-prompt section
├── cordis.patch.yml  # inserts one host-plane row so every Session sees the tools
├── package.json      # bundle manifest (dsh.bundle.patch)
├── LICENSE           # GPL-3.0
└── README.md
```

The patch places the plugin at the host plane rather than inside an agent preset, so **every** Session of the profile sees the same two tools regardless of which preset it runs.

## Compatibility

Developed and tested against a DeepSeek Harness 0.2.x desktop profile (Windows). The host APIs it touches (`sessionController.create` / `resolveAgent` / `rename`, `agent.followup`, `sessions.flush`, `workspaceRegistry.list`) are internal seams and may shift between harness versions — the code fails loudly rather than silently when they do.

## License

[GPL-3.0](./LICENSE) © 2026 Venshell
