/**
 * dsh-session-dm — cross-session direct messages + fresh top-level sessions.
 *
 * SPDX-License-Identifier: GPL-3.0
 *
 * Gives an agent two model-facing tools:
 *
 *   session_dm_send — deliver a text message into ANOTHER Session of the same
 *     workspace. This is the direction the built-in seams do not cover:
 *     `send_message` only reaches a caller's own subagent tree, and the
 *     session-query tools are read-only.
 *
 *   session_create — start a NEW top-level Session in the caller's workspace
 *     and deliver a first prompt to it. This is the in-process equivalent of
 *     the Web UI "new conversation" button: sessionController.create is the
 *     very API the client catalog drives.
 *
 *   session_dm_wait — block until another Session finishes its current turn,
 *     so a sender never has to `sleep` and guess. Waits on the durable
 *     `turn/end` event rather than polling status.
 *
 * Delivery is the routine the built-in schedule service uses for
 * original-Session reminders, so a message behaves like other out-of-band input:
 *
 *   ctx.sessionController.resolveAgent(target)   // live Agent, or cold resume
 *     -> agent.followup(userMessage)              // durable next-turn inbox
 *     -> ctx.sessions.flush(agent.session)        // acknowledged persistence
 *
 * A cold target is therefore woken by the message. The Session inbox is already
 * the mailbox, so this plugin keeps no store and adds no schema.
 *
 * The module imports nothing: it is a profile bundle whose host packages live in
 * the harness installation rather than in the profile's node_modules, and every
 * value it needs arrives through the Cordis context it injects.
 *
 * Authority: a sender may address a Session only when the target header's `cwd`
 * exactly equals the caller's, the conservative rule session-query uses. A
 * Session without a workspace may not address others at all.
 *
 * @module dsh-session-dm
 */

import { randomUUID } from 'node:crypto'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'session-dm'

/** Capability services the tool needs; the Controller is the delivery path. */
export const inject = ['tools', 'systemPrompt', 'sessionQuery', 'sessionController', 'sessions']

/** Source tag recorded on delivered user messages, so a sender stays recoverable. */
const SOURCE_KIND = 'session-dm'

/** Short model guidance; one stable section keeps the request prefix cacheable. */
const PROMPT_TEXT =
  'Cross-session tools: session_dm_send messages another Session in the same workspace (hand off work, ' +
  'ask a parallel Session a question, or relay a result); the target is woken by the message and receives ' +
  'it as user input on its next turn. session_create starts a NEW top-level Session in the same workspace ' +
  'and delivers your prompt as its first user input — use it when the work deserves a fresh conversation ' +
  'rather than burdening an existing one. session_dm_wait blocks until another Session finishes its ' +
  'current turn, so after sending work you can wait for it instead of sleeping. Delivery confirms ' +
  'acceptance, not a reply; to read what another Session said back, use session_search or ' +
  'session_event_read on its id.'

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

/**
 * Deep-freeze a value in place, matching how dsh-llm publishes message records.
 * @param value - the freshly built message.
 * @returns the same, now immutable, value.
 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * Build one identified user message.
 * @param text - the message body the target Session will read.
 * @param fromSessionId - the sending Session, recorded for traceability.
 * @returns an immutable user message with a fresh identity.
 */
function buildUserMessage(text, fromSessionId) {
  return deepFreeze(
    structuredClone({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: SOURCE_KIND, fromSessionId },
    }),
  )
}

/**
 * Resolve one target header and prove the caller may address it.
 * @param ctx - plugin context carrying the session-query service.
 * @param callerCwd - the calling Session's workspace, or undefined.
 * @param targetId - the addressed Session id.
 * @param signal - the tool call's cancellation signal.
 * @returns the target header.
 * @throws when the target is unknown or outside the caller's workspace.
 */
async function authorizeTarget(ctx, callerCwd, targetId, signal) {
  if (callerCwd === undefined) {
    throw new Error(
      'session_dm_send requires the calling Session to have a workspace; set a working directory first',
    )
  }
  const records = await ctx.sessionQuery.filterSessions(
    [{ kind: 'id', values: [targetId] }],
    signal,
  )
  const record = records.find((candidate) => candidate.header.id === targetId)
  if (record === undefined) throw new Error(`session "${targetId}" was not found`)
  if (record.header.cwd !== callerCwd) {
    throw new Error(
      `session "${targetId}" is outside the caller workspace; direct messages require an exact cwd match`,
    )
  }
  return record.header
}

/** Shape a controller resolution into the live Agent or a readable failure. */
function unwrapResolution(resolved, targetId) {
  if (resolved !== null && typeof resolved === 'object' && 'error' in resolved) {
    const reason = resolved.error?.message ?? String(resolved.error)
    throw new Error(`session "${targetId}" could not be resumed for delivery: ${reason}`)
  }
  const agent = resolved?.agent ?? resolved
  if (agent === undefined || agent === null) {
    throw new Error(`session "${targetId}" could not be resumed for delivery`)
  }
  return agent
}

/** Render the delivery receipt the model sees. */
function receipt(targetId, title, wasLive) {
  const label = typeof title === 'string' && title.length > 0 ? `${targetId} — ${title}` : targetId
  return [
    `Delivered to session ${label}.`,
    wasLive
      ? "The message is queued for that Session's next turn."
      : 'That Session was not running, so it was resumed and will handle the message on its next turn.',
    'Delivery confirms acceptance only; read its reply later with session_search or session_event_read.',
  ].join('\n')
}

/**
 * Find the caller's workspace so the new session lands in the same UI group.
 *
 * `sessionController.create` attaches a session to a workspace ONLY when the
 * request names `workspaceId`; a bare `{ cwd }` mint leaves it unattached and
 * the Session list shows it as ungrouped (observed 2026-10-27). The registry
 * is fetched lazily through ctx.get rather than `inject`, so hosts that do
 * not mount it degrade to the cwd-only path instead of failing the plugin.
 *
 * @param ctx - plugin context with the runtime service getter.
 * @param callerId - the calling Session's id (membership match).
 * @param callerCwd - the calling Session's workspace (path fallback).
 * @returns the workspace carrying { id }, or undefined.
 */
function callerWorkspace(ctx, callerId, callerCwd) {
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined
    const workspaces = typeof registry?.list === 'function' ? registry.list() : []
    return (
      workspaces.find((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(callerId)) ??
      workspaces.find((w) => (w?.path ?? w?.cwd) === callerCwd)
    )
  } catch {
    return undefined
  }
}

/**
 * Register the cross-session message tool.
 * @param ctx - context carrying the tool registry, session query, and controller.
 */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:session-dm',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SESSION_QUERY'),
    text: PROMPT_TEXT,
  })

  const tool = {
    name: 'session_dm_send',
    description:
      'Send a text message into another Session in the same workspace. The target Session is resumed if ' +
      'needed and receives the message as user input on its next turn. Use it to hand off work to a ' +
      'parallel Session or to ask one a question; the receipt confirms acceptance, not an answer.',
    // 🔴 必须是**完整 JSON Schema**（type/properties/required/additionalProperties），
    //    不能写宿主 defineTool 的简写格式（`{ field: { type, required: true } }`）：
    //    本插件为保持零依赖没有走 defineTool，裸注册时没有任何一层做 spec→JSONSchema
    //    转换 —— 简写被原样发布后，模型侧看到的参数类型全变成 object；宿主按这份
    //    schema 清洗实参，字符串实参全部不合格 ⇒ execute 收到的 args 恒为 {}。
    //    （2026-10-27 实测：每次调用 args 均为 {}，报 "requires a non-empty message"。）
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description:
            'Target Session id. Find ids with session_search, session_trace, or the Session list in the UI.',
        },
        message: {
          type: 'string',
          description:
            'Message text to deliver. Write it as the human-facing input the target Session should act on.',
        },
      },
      required: ['session_id', 'message'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) {
        throw new Error('session_dm_send requires an agent-bound caller (exec.agent was undefined)')
      }
      const callerId = caller.session.id
      const targetId = args.session_id
      const text = typeof args.message === 'string' ? args.message.trim() : ''
      if (text.length === 0) throw new Error('session_dm_send requires a non-empty message')
      if (targetId === callerId) {
        throw new Error(
          'session_dm_send cannot address the calling Session; reply in place instead of messaging yourself',
        )
      }

      await authorizeTarget(ctx, caller.session.header.cwd, targetId, exec.signal)
      exec.signal?.throwIfAborted?.()

      const wasLive = ctx.sessions.get(targetId) !== undefined
      const agent = unwrapResolution(await ctx.sessionController.resolveAgent(targetId), targetId)

      agent.followup(buildUserMessage(text, callerId))

      const acknowledged = await ctx.sessions.flush(agent.session)
      if (!acknowledged) {
        throw new Error(`delivery to session "${targetId}" was not acknowledged by persistence`)
      }
      ctx.logger?.info?.(`session-dm: ${callerId} -> ${targetId} (${text.length} chars, live=${wasLive})`)

      const title = ctx.sessionQuery
        ? (await safeTitle(ctx, targetId)) ?? agent.session.header?.title
        : agent.session.header?.title
      return receipt(targetId, title, wasLive)
    },
  }

  /**
   * session_create — start a new top-level Session in the caller's workspace.
   *
   * Drives the same host API the Web UI "new conversation" button drives
   * (catalog `session/create` -> sessionController.create). Without a
   * named sessionId the controller mints a fresh `session-<uuid>`, so every
   * call yields a brand-new top-level conversation — never a subagent.
   * The first prompt rides the durable followup inbox, the same channel
   * session_dm_send uses, so it survives even if delivery races startup.
   */
  const createTool = {
    name: 'session_create',
    description:
      'Start a NEW top-level Session (a fresh conversation, not a subagent) in the same workspace as the ' +
      'calling Session and deliver a first prompt to it. The new Session runs independently: it is visible ' +
      'in the Session list, and its output can be read later with session_search or session_event_read. ' +
      'Use it to fan work out into a dedicated conversation.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'First user input for the new Session. Write it as the human-facing task the new conversation should act on.',
        },
        title: {
          type: 'string',
          description: 'Optional display title for the new Session; a title is derived automatically when omitted.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) {
        throw new Error('session_create requires an agent-bound caller (exec.agent was undefined)')
      }
      const callerId = caller.session.id
      const callerCwd = caller.session.header?.cwd
      if (typeof callerCwd !== 'string' || callerCwd.length === 0) {
        throw new Error('session_create requires the calling Session to have a workspace; set a working directory first')
      }
      const text = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (text.length === 0) throw new Error('session_create requires a non-empty prompt')
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      exec.signal?.throwIfAborted?.()

      // Same host API the Web UI "new conversation" button drives
      // (SessionController.create -> SessionCommandController.create). The
      // request is mutually exclusive: workspaceId XOR cwd — the workspace's
      // own path supplies the cwd when workspaceId is named. A bare { cwd }
      // mint skips workspace.attachSession and lands in the UI as ungrouped,
      // so prefer the workspaceId form and fall back to cwd only when no
      // workspace matches the caller.
      const workspace = callerWorkspace(ctx, callerId, callerCwd)
      const request =
        workspace?.id !== undefined
          ? { workspaceId: workspace.id }
          : { cwd: callerCwd }
      const created = await ctx.sessionController.create(request)
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('session_create could not determine the new session id')
      }
      // The new Agent is live right after create; resolveAgent returns it
      // without a resume round-trip.
      const agent = unwrapResolution(await ctx.sessionController.resolveAgent(sessionId), sessionId)

      // First prompt: durable followup inbox (same channel as session_dm_send).
      agent.followup(buildUserMessage(text, callerId))
      const acknowledged = await ctx.sessions.flush(agent.session)
      if (!acknowledged) {
        throw new Error(`delivery to new session "${sessionId}" was not acknowledged by persistence`)
      }

      // Best-effort title; a rename failure never fails a session that exists.
      if (title.length > 0) {
        try {
          await ctx.sessionController.rename({ sessionId, title })
        } catch {
          /* keep the derived title */
        }
      }
      ctx.logger?.info?.(
        `session-dm: ${callerId} created ${sessionId} in ${callerCwd} (prompt ${text.length} chars)`,
      )

      return [
        `Created new top-level session ${sessionId} in ${callerCwd}.`,
        title.length > 0 ? `Title: ${title}.` : 'The title will be derived from the conversation.',
        'Your prompt is its first user input and it will start processing on its next turn.',
        'Read its progress later with session_search or session_event_read on this id.',
      ].join('\n')
    },
  }

  /**
   * session_dm_wait — block until another Session finishes its current turn.
   *
   * Without this a sender has to `sleep` and guess how long the target needs.
   * The host's own guidance is explicit: wait on the durable `turn/end` event,
   * do NOT poll `agent.status` — and `agent.whenIdle()` is unusable here for
   * the same reason, since several queued inputs share one running interval
   * and it resolves only after the whole agent quiesces (which, right after
   * followup(), is after the input we just sent actually completes).
   *
   * The wait therefore races three things:
   *   1. a `session/event` subscription for the target's next `turn/end`;
   *   2. `agent.whenIdle()`, because a cold target that was just resumed may
   *      already be idle with nothing pending (no turn/end will ever come);
   *   3. a timeout, so a stuck target cannot hang the caller forever.
   *
   * A settled turn is reported with its reason, the last assistant text, and
   * the resulting Session error if the turn failed.
   */
  const waitTool = {
    name: 'session_dm_wait',
    description:
      'Block until another Session finishes its current turn, then return what happened (turn end reason, ' +
      'last assistant text, or the Session error). Use it after session_dm_send or session_create so you can ' +
      'wait for the other Session instead of sleeping and guessing. Returns as soon as the target is idle if ' +
      'it has no work pending; times out if the target neither finishes nor idles.',
    parameters: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description:
            'Target Session id. Find ids with session_search, session_trace, or the Session list in the UI.',
        },
        timeout_seconds: {
          type: 'number',
          description:
            'How long to wait before giving up, in seconds. Defaults to 300 (5 minutes). Use a larger value for long tasks.',
        },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) {
        throw new Error('session_dm_wait requires an agent-bound caller (exec.agent was undefined)')
      }
      const callerId = caller.session.id
      const targetId = args.session_id
      const rawTimeout = Number(args.timeout_seconds)
      const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.min(rawTimeout, 3600) * 1000 : 300_000

      const header = await authorizeTarget(ctx, caller.session.header.cwd, targetId, exec.signal)
      exec.signal?.throwIfAborted?.()

      const agent = unwrapResolution(await ctx.sessionController.resolveAgent(targetId), targetId)
      exec.signal?.throwIfAborted?.()

      // Snapshot BEFORE subscribing, so a turn that ends between resolution and
      // subscription still shows up as a seq advance on the poll fallback.
      const startSeq = agent.session.seq
      const alreadyIdle = agent.status === 'idle' && !agent.inbox.hasPending
      if (alreadyIdle) {
        return waitReceipt(targetId, header?.title, 'idle', { startSeq, endSeq: startSeq, reason: undefined })
      }

      const settled = await new Promise((resolve) => {
        let done = false
        let timer
        let poll
        const finish = (outcome) => {
          if (done) return
          done = true
          if (timer !== undefined) clearTimeout(timer)
          if (poll !== undefined) clearInterval(poll)
          dispose()
          resolve(outcome)
        }

        // Path 1: the durable turn/end for this Session.
        const dispose = ctx.on(
          'session/event',
          (session, event) => {
            if (session.id !== targetId) return
            if (event.type === 'turn/end') {
              finish({ kind: 'turn-end', reason: event.data?.reason, endSeq: event.seq })
            } else if (event.type === 'agent/error' || event.type === 'session/error') {
              finish({ kind: 'error', error: event.data })
            }
          },
          { global: true },
        )

        // Path 2: the agent quiesced with nothing left to do. Covers a resumed
        // Session whose turn already ended before we started listening.
        Promise.resolve(agent.whenIdle?.()).then(
          () => finish({ kind: 'idle', endSeq: agent.session.seq }),
          () => finish({ kind: 'idle', endSeq: agent.session.seq }),
        )

        // Path 3: belt and braces. turn/end appends durably, so a seq advance
        // past the snapshot means a turn completed even if the event listener
        // missed the frame (cold resume, reconnect, listener registered late).
        // Neither timer is unref'd: an active wait must keep the process alive,
        // and unref'd timers let a pending await hang forever if the loop empties.
        poll = setInterval(() => {
          if (agent.session.seq > startSeq && agent.status === 'idle') {
            finish({ kind: 'turn-end', reason: undefined, endSeq: agent.session.seq })
          }
        }, 1000)

        timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
        exec.signal?.addEventListener?.('abort', () => finish({ kind: 'timeout' }), { once: true })
      })

      if (settled.kind === 'timeout') {
        return [
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for session ${targetId}.`,
          agent.status === 'running'
            ? 'It is still running — call session_dm_wait again with a larger timeout_seconds.'
            : 'It is not running but did not report a turn end; read its state with session_event_read.',
        ].join('\n')
      }
      return waitReceipt(targetId, header?.title, settled.kind, settled)
    },
  }

  ctx.tools.register(tool)
  ctx.tools.register(createTool)
  ctx.tools.register(waitTool)
}

/**
 * Render what a finished wait observed.
 * @param targetId - the Session that settled.
 * @param title - its display title, when known.
 * @param kind - how the wait settled (turn-end, idle, error).
 * @param settled - the observed sequence and failure details.
 * @returns the model-facing receipt.
 */
function waitReceipt(targetId, title, kind, settled) {
  const label = typeof title === 'string' && title.length > 0 ? `${targetId} — ${title}` : targetId
  const when = typeof settled.endSeq === 'number' ? ` (session seq ${settled.endSeq})` : ''
  if (kind === 'timeout') return `Session ${label} did not settle.`
  if (kind === 'error') {
    const message = settled.error?.message ?? settled.error?.error?.message ?? JSON.stringify(settled.error ?? null)
    return `Session ${label} failed${when}: ${message}`
  }
  if (kind === 'idle') {
    return [
      `Session ${label} is idle${when} — nothing is pending, so there was nothing to wait for.`,
      'If you expected it to be working, the message may not have started a turn yet; read it with session_event_read.',
    ].join('\n')
  }
  const reason = settled.reason?.kind ?? settled.reason ?? 'completed'
  return [
    `Session ${label} finished its turn${when}.`,
    `End reason: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}.`,
    'Read its reply with session_search or session_event_read on this id.',
  ].join('\n')
}

/**
 * Best-effort title lookup; a missing title never fails a delivery that landed.
 * @param ctx - plugin context carrying the session-query service.
 * @param sessionId - the delivered-to Session.
 * @returns its title, or undefined.
 */
async function safeTitle(ctx, sessionId) {
  try {
    const snapshots = await ctx.sessionQuery.readTitleSnapshots([sessionId])
    const snapshot = snapshots?.[0]
    if (snapshot && snapshot.status !== 'rejected') return snapshot.value?.title?.title
  } catch {
    return undefined
  }
  return undefined
}
