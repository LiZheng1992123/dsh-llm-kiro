/**
 * One warm inner Kiro CLI session per host session id: a `kiro-cli acp`
 * subprocess whose model turns stream out as harness `StreamChunk`s. Host
 * tool calls travel through a per-session loopback MCP HTTP server: the
 * handler parks on a promise, the adapter finishes the turn with
 * `tool-calls`, and the next host request (carrying tool results) resolves
 * the parked promise so the inner model continues with the result in place.
 * @module dsh-llm-kiro/session
 */

import {
  CallId, CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmError, QUOTA_EXCEEDED_CODE,
  isContextWindowExceededError, isQuotaExceededError,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, FinishReason, GenerateOptions, Message, StreamChunk, TokenUsage, ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { AcpClient, type AcpMetadata, type AcpSessionUpdate } from './acp.ts'
import { HostMcpServer } from './mcpserver.ts'
import { renderInitialFeed } from './render.ts'

/** MCP server name this adapter exposes host tools under. */
export const MCP_SERVER_NAME = 'dsh-host'

/** How long an MCP tool handler waits for the host tool result before failing the call. */
const TOOL_RESULT_TIMEOUT_MS = 120_000

/**
 * Quiet window after the latest MCP tool call before the host turn ends with
 * `tool-calls`. kiro fires parallel tool calls as concurrent HTTP requests;
 * the window lets stragglers join the same turn instead of hitting the
 * no-active-turn timeout path.
 */
const TOOL_SETTLE_MS = 400

type QueueItem =
  | { kind: 'chunk', chunk: StreamChunk }
  | { kind: 'turn-end', reason: FinishReason }

/** Unbounded FIFO the consumer pushes into and the active turn pumps out. */
class TurnQueue implements AsyncIterable<QueueItem> {
  private readonly items: QueueItem[] = []
  private resolve: ((result: IteratorResult<QueueItem>) => void) | null = null
  private closed = false

  push(item: QueueItem): void {
    if (this.closed) return
    if (this.resolve !== null) {
      const settle = this.resolve
      this.resolve = null
      settle({ value: item, done: false })
    } else {
      this.items.push(item)
    }
  }

  close(): void {
    this.closed = true
    if (this.resolve !== null) {
      const settle = this.resolve
      this.resolve = null
      settle({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<QueueItem> {
    return {
      next: (): Promise<IteratorResult<QueueItem>> => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise(settle => { this.resolve = settle })
      },
    }
  }

  /** Whether the turn already ended; late pushes are dropped. */
  get isClosed(): boolean {
    return this.closed
  }
}

interface ParkedResolver { (result: { text: string, isError: boolean }): void }

export interface KiroSessionOptions {
  /** kiro-cli executable (default `kiro-cli`). */
  cliPath?: string
}

/**
 * One warm inner session. The ACP subprocess, the kiro-side session id, and
 * the MCP HTTP server are owned here; the model/effort are fixed at spawn —
 * a model change is an adapter-level rebuild, not an in-place switch.
 */
export class KiroSession {
  private client: AcpClient | null = null
  private starting: Promise<void> | null = null
  private kiroSessionId: string | null = null
  private readonly mcp = new HostMcpServer()
  private mcpStarted = false
  private queue: TurnQueue | null = null
  private promptSettled: (() => void) | null = null
  private promptInFlight = false
  private readonly parked = new Map<string, ParkedResolver>()
  /** Parked calls that arrived with no active turn; emitted at next stream start. */
  private readonly unemitted = new Map<string, { name: string, argumentsText: string }>()
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private callCounter = 0
  private abortPending = false
  private disposed = false
  private dead = false

  /** Previous request's messages for delta feeding. */
  fedMessages: readonly Message[] | undefined
  fedSystem: string | undefined
  /** This turn's fed characters, reset per turn for per-call token accounting. */
  turnInputChars = 0

  private readonly model: string
  private readonly reasoningEffort: string | undefined
  private sessionCwd: string | undefined
  private contextWindowHint: number | undefined

  // Active-turn assembly state.
  private blockIndex = 0
  private textBlock: { index: number, text: string } | undefined
  private reasoningBlock: { index: number, text: string } | undefined
  private toolCallsThisTurn = 0
  private sawAnyContentThisTurn = false
  private outputChars = 0
  private reasoningChars = 0
  /** Latest kiro-reported context occupancy (percent of the model window). */
  private lastContextPct: number | undefined
  /**
   * Session-level input token estimate for the CURRENT request, priced the
   * same way the harness token meter prices the surface (4 chars per token
   * on the rendered conversation). Fallback when kiro has not reported a
   * contextUsagePercentage this turn.
   */
  private estimatedInputTokens: number | undefined

  constructor(
    readonly sessionId: string,
    model: string,
    reasoningEffort?: string,
    private readonly options: KiroSessionOptions = {},
  ) {
    this.model = model
    this.reasoningEffort = reasoningEffort
  }

  /** The model this session's subprocess was spawned with. */
  get currentModel(): string {
    return this.model
  }

  /** The effort this session's subprocess was spawned with. */
  get currentEffort(): string | undefined {
    return this.reasoningEffort
  }

  /** Whether the inner subprocess died; the adapter rebuilds dead sessions. */
  get isDead(): boolean {
    return this.dead
  }

  /** Record the host session workspace; effective only before spawn. */
  setCwd(cwd: string | undefined): void { this.sessionCwd = cwd }

  /**
   * Record the model's advertised context window so kiro's
   * contextUsagePercentage can be priced into input tokens for the harness
   * context meter.
   */
  setContextWindowHint(window: number | undefined): void { this.contextWindowHint = window }

  /** Register any host tools whose schema this session's MCP server lacks. */
  ensureTools(tools: readonly ToolSchema[]): void {
    this.mcp.ensureTools(tools)
  }

  /** Spawn the subprocess, start the MCP server, create the kiro session. */
  private async ensureStarted(): Promise<void> {
    if (this.starting !== null) return this.starting
    this.starting = (async () => {
      const client = new AcpClient({
        cliPath: this.options.cliPath ?? 'kiro-cli',
        model: this.model,
        ...this.reasoningEffort === undefined ? {} : { effort: this.reasoningEffort },
      })
      client.onUpdate = (sessionId, update) => this.handleUpdate(sessionId, update)
      client.onMetadata = metadata => this.handleMetadata(metadata)
      client.onPermissionRequest = (params) => {
        const meta = params.toolCall?._meta?.kiro
        const title = params.toolCall?.title ?? ''
        if (meta?.mcpServerName === MCP_SERVER_NAME || title.includes(`@${MCP_SERVER_NAME}/`)) return 'allow' as const
        return 'deny' as const
      }
      client.onExit = (error) => this.handleExit(error)
      this.mcp.handler = (name, args) => this.handleMcpCall(name, args)
      await client.start()
      const mcpUrl = await this.mcp.start()
      this.mcpStarted = true
      const { sessionId } = await client.newSession(this.sessionCwd ?? process.cwd(), [{
        name: MCP_SERVER_NAME,
        type: 'http',
        url: mcpUrl,
        headers: [],
      }])
      this.kiroSessionId = sessionId
      this.client = client
    })()
    try {
      await this.starting
    } catch (error) {
      this.dead = true
      throw new LlmError(
        `kiro session ${this.sessionId} failed to start: ${String(error)}`,
        'TRANSPORT',
      )
    }
  }

  /** Deliver host tool results to parked handlers, keyed by callId. */
  deliverToolResults(tail: readonly Message[]): void {
    let freshUserTurn = false
    for (const message of tail) {
      if (message.role === 'user' && message.source.kind !== 'tool') {
        freshUserTurn = true
        continue
      }
      if (message.role !== 'user' || message.source.kind !== 'tool') continue
      const block = message.content[0]
      if (block === undefined || block.type !== 'tool-result') continue
      const callId = String(block.toolCallId)
      const payload = { text: renderResultText(block.content), isError: block.isError === true }
      const resolve = this.parked.get(callId)
      if (resolve !== undefined) {
        this.parked.delete(callId)
        resolve(payload)
      }
    }
    // The host started a new user turn while calls were still parked: unstick
    // the inner process with explicit cancellation results; stream() cancels
    // the in-flight prompt before sending the new one.
    if (freshUserTurn && this.parked.size > 0) {
      const stale = [...this.parked.values()]
      this.parked.clear()
      for (const resolve of stale) resolve({ text: '[宿主取消了这次工具执行]', isError: true })
    }
  }

  /** Run one inner turn: feed (if any) then pump consumer chunks until finish. */
  async *stream(options: GenerateOptions, feed: string | null): AsyncGenerator<StreamChunk> {
    if (this.queue !== null) throw new LlmError(`kiro session ${this.sessionId} already has a turn in flight`, 'CONFLICT')
    if (this.disposed) throw new LlmError(`kiro session ${this.sessionId} was disposed`, 'TRANSPORT')
    if (this.dead) throw new LlmError(`kiro session ${this.sessionId} subprocess died`, 'TRANSPORT')
    await this.ensureStarted()
    // A fresh user turn can arrive while the previous prompt is still parked
    // on tool results: cancel and drain it before prompting anew.
    if (feed !== null && this.promptInFlight) await this.cancelAndDrain()
    this.queue = new TurnQueue()
    this.resetTurnState()
    // Parallel tool calls that landed in the gap between turns are emitted
    // now, at the head of this turn, and end it with tool-calls once the
    // settle window closes.
    for (const [pendingId, call] of this.unemitted) {
      this.unemitted.delete(pendingId)
      this.emitToolCall(pendingId, call.name, call.argumentsText)
    }
    if (this.toolCallsThisTurn > 0) this.armSettleTimer()
    if (feed !== null) {
      this.turnInputChars += feed.length
      this.startPrompt(feed)
    }
    const signal = options.signal
    let abortTimer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      this.abortPending = true
      const id = this.kiroSessionId
      if (id !== null) void this.client?.cancel(id)
      // Fallback: end the turn if the inner process does not settle promptly.
      abortTimer = setTimeout(() => this.endTurn({ kind: 'aborted', failure: { message: 'kiro session aborted by host', code: 'ABORTED' } }), 5_000)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      for await (const item of this.queue) {
        if (item.kind === 'chunk') {
          yield item.chunk
          continue
        }
        yield { type: 'usage', usage: this.usage() }
        yield { type: 'finish', reason: item.reason }
        return
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (abortTimer !== undefined) clearTimeout(abortTimer)
      this.queue = null
      this.abortPending = false
      if (this.settleTimer !== null) {
        clearTimeout(this.settleTimer)
        this.settleTimer = null
      }
    }
  }

  /** Tear the subprocess and MCP server down; parked calls die with it. */
  close(): void {
    if (this.disposed) return
    this.disposed = true
    const stale = [...this.parked.values()]
    this.parked.clear()
    this.unemitted.clear()
    for (const resolve of stale) resolve({ text: '[宿主会话已关闭]', isError: true })
    if (this.client !== null) void this.client.close().catch(() => undefined)
    if (this.mcpStarted) void this.mcp.close().catch(() => undefined)
  }

  /** Fire the prompt RPC; settlement ends the turn (see handlePromptSettled). */
  private startPrompt(feed: string): void {
    const client = this.client
    const sessionId = this.kiroSessionId
    if (client === null || sessionId === null) {
      this.endTurn({ kind: 'error', failure: { message: 'kiro session not started', code: 'TRANSPORT' } })
      return
    }
    this.promptInFlight = true
    client.prompt(sessionId, feed).then(
      ({ stopReason }) => this.handlePromptSettled(stopReason, undefined),
      (error: unknown) => this.handlePromptSettled(undefined, error),
    )
  }

  private handlePromptSettled(stopReason: string | undefined, error: unknown): void {
    this.promptInFlight = false
    this.promptSettled?.()
    this.promptSettled = null
    if (this.abortPending) {
      this.endTurn({ kind: 'aborted', failure: { message: 'kiro turn aborted by host', code: 'ABORTED' } })
      return
    }
    if (error !== undefined) {
      const detail = error instanceof Error ? error.message : String(error)
      this.endTurn({
        kind: 'error',
        failure: { message: `kiro turn failed: ${detail}`, code: classifyTurnError(detail) },
      })
      return
    }
    if (stopReason === 'cancelled') {
      this.endTurn({ kind: 'aborted', failure: { message: 'kiro turn cancelled', code: 'ABORTED' } })
      return
    }
    if (this.toolCallsThisTurn > 0) {
      // The settle timer already ended this turn with tool-calls; a late
      // prompt settlement after tool parking means the model stopped without
      // consuming results (e.g. host never delivered) — nothing more to do.
      if (this.queue === null || this.queue.isClosed) return
      this.endTurn({ kind: 'tool-calls' })
      return
    }
    if (!this.sawAnyContentThisTurn) {
      this.endTurn({
        kind: 'error',
        failure: { message: 'kiro model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
      })
      return
    }
    this.endTurn({ kind: 'stop' })
  }

  /** Cancel the in-flight prompt and wait for it to settle (bounded). */
  private async cancelAndDrain(): Promise<void> {
    const client = this.client
    const sessionId = this.kiroSessionId
    if (client === null || sessionId === null || !this.promptInFlight) return
    const settled = new Promise<void>(resolve => { this.promptSettled = resolve })
    await client.cancel(sessionId)
    const timer = new Promise<void>(resolve => { setTimeout(resolve, 10_000) })
    await Promise.race([settled, timer])
    if (this.promptInFlight) {
      // Cancel did not take: the subprocess is unresponsive; declare it dead
      // so the adapter rebuilds instead of feeding a wedged session.
      this.dead = true
      this.promptInFlight = false
      void client.close().catch(() => undefined)
      throw new LlmError(`kiro session ${this.sessionId} did not settle after cancel`, 'TRANSPORT')
    }
  }

  /** Emit one complete tool call (MCP input arrives whole, not streamed). */
  private emitToolCall(callId: string, name: string, argumentsText: string): void {
    const chunkIndex = this.blockIndex++
    this.toolCallsThisTurn += 1
    this.sawAnyContentThisTurn = true
    this.emit({ type: 'block-start', index: chunkIndex, blockType: 'tool-call' })
    this.emit({
      type: 'tool-call-delta',
      index: chunkIndex,
      id: CallId(callId),
      name,
      argumentsDelta: argumentsText,
    })
    this.emit({
      type: 'block-end',
      index: chunkIndex,
      block: { type: 'tool-call', id: CallId(callId), name, arguments: argumentsText },
    })
  }

  /** MCP `tools/call` entry point: emit the host tool call, then park. */
  private handleMcpCall(name: string, args: Record<string, unknown>): Promise<{ text: string, isError: boolean }> {
    const callId = `kiro-${++this.callCounter}`
    const argumentsText = Object.keys(args).length > 0 ? JSON.stringify(args) : ''
    // Only host-visible tool calls may be emitted: a call that arrives while
    // no host stream is active is buffered and emitted at the next stream
    // start, so parallel calls landing in the inter-turn gap cannot wedge
    // the prompt RPC until the park timeout.
    if (this.queue !== null && !this.queue.isClosed) {
      this.emitToolCall(callId, name, argumentsText)
      this.armSettleTimer()
    } else {
      this.unemitted.set(callId, { name, argumentsText })
    }
    return new Promise<{ text: string, isError: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        this.parked.delete(callId)
        this.unemitted.delete(callId)
        resolve({
          text: `宿主在 ${TOOL_RESULT_TIMEOUT_MS / 1000}s 内未返回工具结果（callId=${callId}），本次工具调用已取消`,
          isError: true,
        })
      }, TOOL_RESULT_TIMEOUT_MS)
      this.parked.set(callId, (payload) => {
        clearTimeout(timer)
        resolve(payload)
      })
    })
  }

  /**
   * (Re)arm the quiet window: when it expires without new MCP calls, the
   * model is fully blocked on tool results, so the host turn ends with
   * `tool-calls` and the host takes over execution.
   */
  private armSettleTimer(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      if (this.queue === null || this.queue.isClosed) return
      if (this.toolCallsThisTurn > 0) this.endTurn({ kind: 'tool-calls' })
    }, TOOL_SETTLE_MS)
  }

  /** ACP `session/update` consumer. */
  private handleUpdate(sessionId: string, update: AcpSessionUpdate): void {
    if (sessionId !== this.kiroSessionId) return
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      const text = update.content.text ?? ''
      if (text.length === 0) return
      if (this.textBlock === undefined) {
        this.textBlock = { index: this.blockIndex++, text: '' }
        this.emit({ type: 'block-start', index: this.textBlock.index, blockType: 'text' })
      }
      this.textBlock.text += text
      this.outputChars += text.length
      this.sawAnyContentThisTurn = true
      this.emit({ type: 'text-delta', index: this.textBlock.index, text })
      return
    }
    if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.type === 'text') {
      const text = update.content.text ?? ''
      if (text.length === 0) return
      if (this.reasoningBlock === undefined) {
        this.reasoningBlock = { index: this.blockIndex++, text: '' }
        this.emit({ type: 'block-start', index: this.reasoningBlock.index, blockType: 'reasoning' })
      }
      this.reasoningBlock.text += text
      this.reasoningChars += text.length
      this.sawAnyContentThisTurn = true
      this.emit({ type: 'reasoning-delta', index: this.reasoningBlock.index, text })
      return
    }
    // tool_call / tool_call_update updates are intentionally not consumed:
    // host tool calls are emitted by the MCP bridge (which carries complete
    // arguments), and native tools are denied at the permission gate.
  }

  /** ACP `_kiro.dev/metadata` consumer: real context occupancy + metering. */
  private handleMetadata(metadata: AcpMetadata): void {
    if (metadata.sessionId !== undefined && metadata.sessionId !== this.kiroSessionId) return
    if (typeof metadata.contextUsagePercentage === 'number') {
      this.lastContextPct = metadata.contextUsagePercentage
    }
  }

  /** Subprocess exit: fail the turn and every parked tool call. */
  private handleExit(error: Error): void {
    this.dead = true
    this.promptInFlight = false
    const stale = [...this.parked.values()]
    this.parked.clear()
    for (const resolve of stale) resolve({ text: `[kiro-cli 进程已退出: ${error.message}]`, isError: true })
    this.endTurn({
      kind: 'error',
      failure: { message: `kiro session died: ${error.message}`, code: 'TRANSPORT' },
    })
  }

  private resetTurnState(): void {
    this.blockIndex = 0
    this.textBlock = undefined
    this.reasoningBlock = undefined
    this.toolCallsThisTurn = 0
    this.sawAnyContentThisTurn = false
    this.turnInputChars = 0
    this.outputChars = 0
    this.reasoningChars = 0
  }

  private emit(chunk: StreamChunk): void { this.queue?.push({ kind: 'chunk', chunk }) }

  private usage(): TokenUsage {
    const outputTokens = Math.max(1, Math.ceil((this.outputChars + this.reasoningChars) / 4))
    const reasoning = this.reasoningChars > 0 ? { reasoningTokens: Math.ceil(this.reasoningChars / 4) } : {}
    // Prefer kiro's real occupancy report: contextUsagePercentage priced
    // against the advertised model window.
    if (this.lastContextPct !== undefined && this.contextWindowHint !== undefined && this.contextWindowHint > 0) {
      return {
        inputTokens: Math.max(1, Math.round((this.lastContextPct / 100) * this.contextWindowHint)),
        outputTokens,
        ...reasoning,
      }
    }
    // Fallback: the session-level estimate, priced like the harness token
    // meter (4 chars per token over the rendered conversation).
    if (this.estimatedInputTokens !== undefined && this.estimatedInputTokens > 0) {
      return { inputTokens: this.estimatedInputTokens, outputTokens, ...reasoning }
    }
    return {
      inputTokens: Math.max(1, Math.ceil(this.turnInputChars / 4)),
      outputTokens,
      ...reasoning,
    }
  }

  /**
   * Record the input-token estimate for the CURRENT request, priced the same
   * way the harness token meter prices the surface: 4 chars per token over
   * the rendered conversation (system + messages) the inner session receives.
   */
  recordRequestInput(system: string | undefined, messages: readonly Message[]): void {
    const rendered = renderInitialFeed(system, messages)
    this.estimatedInputTokens = Math.max(1, Math.ceil(rendered.length / 4))
  }

  private endTurn(reason: FinishReason): void {
    if (this.queue === null) return
    if (this.textBlock !== undefined) {
      this.emit({ type: 'block-end', index: this.textBlock.index, block: { type: 'text', text: this.textBlock.text } })
    }
    if (this.reasoningBlock !== undefined) {
      this.emit({ type: 'block-end', index: this.reasoningBlock.index, block: { type: 'reasoning', text: this.reasoningBlock.text } })
    }
    this.queue.push({ kind: 'turn-end', reason })
    this.queue.close()
  }
}

/** Render tool-result content blocks into the single text the inner model reads. */
export function renderResultText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push('[图片结果]')
    else parts.push(JSON.stringify(block))
  }
  return parts.join('\n')
}

/**
 * Classify an inner failure into a harness-routable code. kiro-cli reports
 * context-window and quota rejections as generic errors, so their message
 * text must be recognized through the shared dsh-llm classifiers; only then
 * does the harness overflow recovery (or quota surfacing) fire instead of a
 * dead-end BACKEND_TURN_ERROR.
 */
export function classifyTurnError(detail: string): string {
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  return 'BACKEND_TURN_ERROR'
}

/**
 * Warm-session registry with insertion-order LRU eviction, plus the cold
 * one-shot path for side-channel requests (titles, compaction).
 */
export class KiroSessionManager {
  private readonly sessions = new Map<string, KiroSession>()

  constructor(
    readonly maxSessions = 8,
    private readonly options: KiroSessionOptions = {},
  ) {}

  /** Existing or fresh warm session for one host session id. */
  forSession(sessionId: string, model: string, reasoningEffort?: string): KiroSession {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      this.sessions.delete(sessionId)
      this.sessions.set(sessionId, existing)
      return existing
    }
    const session = new KiroSession(sessionId, model, reasoningEffort, this.options)
    this.sessions.set(sessionId, session)
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) break
      const victim = this.sessions.get(oldest.value)
      this.sessions.delete(oldest.value)
      victim?.close()
    }
    return session
  }

  /** Drop one session (history diverged or model changed); the next request rebuilds it cold. */
  dispose(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    this.sessions.delete(sessionId)
    session.close()
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }
}
