/**
 * `KiroAdapter`: route the harness LLM seam onto a local Kiro CLI account
 * through the Agent Client Protocol (`kiro-cli acp`). One warm inner session
 * per host session id carries the conversation (model turns and tool rounds
 * live inside it); host tool schemas are exposed to the inner model through
 * a per-session loopback MCP HTTP server whose handlers park until the host
 * delivers tool results on the next request. Side-channel requests (titles,
 * compaction) run cold one-shots.
 * @module dsh-llm-kiro/adapter
 */

import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo, LlmResolvedModelInfo, Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AcpClient } from './acp.ts'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, KIRO_MODELS, resolveKiroModelId } from './catalog.ts'
import { DEFAULT_MODEL_CACHE_TTL_MS, KiroModelCatalog } from './models.ts'
import { renderInitialFeed, renderRefreshed, renderUserTurn } from './render.ts'
import { classifyTurnError, KiroSession, KiroSessionManager } from './session.ts'

/** The provider route this adapter serves. */
export const KIRO_PROVIDER = 'kiro'

/** Options for {@link KiroAdapter}. */
export interface KiroAdapterOptions {
  /** Maximum simultaneously warm inner sessions (default 8). */
  maxSessions?: number
  /** How long a fetched CLI model catalog stays fresh (default 5 min). */
  modelCacheTtlMs?: number
  /** kiro-cli executable (default `kiro-cli`). */
  cliPath?: string
}

/**
 * Reasoning efforts kiro-cli accepts via `--effort`. The CLI model catalog
 * does not report per-model effort support, so every model advertises the
 * same set; the CLI validates the choice at spawn.
 */
const KIRO_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** Human display name for the effort ids. */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}

/** The `reasoning` metadata block every resolved Kiro model advertises. */
function reasoningInfo(): LlmModelReasoningInfo {
  return {
    efforts: KIRO_REASONING_EFFORTS.map(id => ({ id: ReasoningEffortId(id), name: EFFORT_NAMES[id] ?? id })),
  }
}

/**
 * The Kiro-backed adapter. Session continuity, tool parking, and feed
 * planning live here; chunk synthesis lives in the session's ACP consumer.
 */
export class KiroAdapter extends LlmAdapter {
  private readonly sessions: KiroSessionManager
  private readonly catalog: KiroModelCatalog
  private readonly cliPath: string

  constructor(options: KiroAdapterOptions = {}) {
    super()
    this.cliPath = options.cliPath ?? 'kiro-cli'
    this.sessions = new KiroSessionManager(options.maxSessions ?? 8, { cliPath: this.cliPath })
    this.catalog = new KiroModelCatalog(options.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS, this.cliPath)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Kiro CLI' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.catalog.models()
    return models.map(entry => ({
      provider,
      id: entry.id,
      name: entry.name,
      ...entry.description === undefined ? {} : { description: entry.description },
      inputModalities: ['text' as const],
    }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const live = (await this.catalog.liveModels()).find(entry => entry.id === model)
    if (live !== undefined) {
      return {
        provider,
        id: live.id,
        name: live.name,
        ...live.description === undefined ? {} : { description: live.description },
        inputModalities: ['text' as const],
        context: {
          // kiro-cli reports one window per model (context_window_tokens);
          // kiro's own contextUsagePercentage is priced against the same
          // window, keeping the harness context meter and compaction
          // thresholds aligned with what the CLI actually enforces.
          contextWindow: live.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        },
        defaultMaxTokens: DEFAULT_MAX_TOKENS,
        reasoning: reasoningInfo(),
      }
    }
    const configured = KIRO_MODELS.find(entry => entry.id === model)
    return {
      provider,
      id: model,
      name: configured?.name ?? model,
      ...configured?.description === undefined ? {} : { description: configured.description },
      inputModalities: ['text' as const],
      context: { contextWindow: configured?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      reasoning: reasoningInfo(),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const model = resolveKiroModelId(options.model)
    if (options.sessionId === undefined || options.purpose !== undefined) {
      const prompt = renderInitialFeed(options.system, options.messages)
        + '\n（这是一次性旁路请求，直接输出下一条助手回复。）'
      // Side channels (titles, compaction summaries) reuse the main session's
      // model so dsh's recorded summarization target matches what kiro-cli
      // actually runs — a different default route could have different
      // context limits or quota, silently failing the compaction.
      yield* this.coldStream(options, prompt, model)
      return
    }
    const sessionId = String(options.sessionId)
    const effort = options.reasoningEffort
    let session = this.sessions.forSession(sessionId, model, effort)
    // Model and effort are kiro-cli spawn-time arguments; a change (or a dead
    // subprocess) rebuilds the inner session cold from the host history.
    if (session.isDead || session.currentModel !== model || session.currentEffort !== effort) {
      this.sessions.dispose(sessionId)
      session = this.sessions.forSession(sessionId, model, effort)
    }
    if (session.fedMessages === undefined) {
      yield* this.firstTurn(session, options)
      return
    }
    session.deliverToolResults(options.messages.slice(session.fedMessages.length))
    const plan = planContinuation(session.fedMessages, options.messages)
    if (plan.rebuild) {
      this.sessions.dispose(sessionId)
      session = this.sessions.forSession(sessionId, model, effort)
      yield* this.firstTurn(session, options)
      return
    }
    session.ensureTools(options.tools ?? [])
    session.recordRequestInput(options.system, options.messages)
    session.fedMessages = options.messages
    session.fedSystem = options.system
    yield* session.stream(options, plan.feed)
  }

  private async *firstTurn(
    session: KiroSession,
    options: GenerateOptions,
  ): AsyncGenerator<StreamChunk> {
    // Older dsh-llm releases lack the cwd field on GenerateOptions; read it
    // through the widened view so this adapter compiles against the peer range.
    const cwd = (options as GenerateOptions & { cwd?: string }).cwd
    session.setCwd(cwd)
    session.setContextWindowHint(await this.contextWindowOf(session.currentModel))
    session.ensureTools(options.tools ?? [])
    session.recordRequestInput(options.system, options.messages)
    session.fedMessages = options.messages
    session.fedSystem = options.system
    yield* session.stream(options, renderInitialFeed(options.system, options.messages))
  }

  /** The advertised window for one model, for occupancy pricing. */
  private async contextWindowOf(model: string): Promise<number | undefined> {
    const live = (await this.catalog.liveModels()).find(entry => entry.id === model)
    return live?.contextWindow
      ?? KIRO_MODELS.find(entry => entry.id === model)?.contextWindow
      ?? DEFAULT_CONTEXT_WINDOW
  }

  /** One-shot turn with no warm state: side channels and cold rebuilds. */
  private async *coldStream(
    options: GenerateOptions,
    prompt: string,
    model: string,
  ): AsyncGenerator<StreamChunk> {
    const client = new AcpClient({
      cliPath: this.cliPath,
      model,
      ...options.reasoningEffort === undefined ? {} : { effort: options.reasoningEffort },
    })
    client.onPermissionRequest = () => 'deny'
    let text = ''
    let failure: { message: string, code: string } | undefined
    client.onUpdate = (_sessionId, update) => {
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        text += update.content.text ?? ''
      }
    }
    const signal = options.signal
    let sessionId: string | null = null
    const onAbort = (): void => {
      if (sessionId !== null) void client.cancel(sessionId)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await client.start()
      const cwd = (options as GenerateOptions & { cwd?: string }).cwd ?? process.cwd()
      const created = await client.newSession(cwd, [])
      sessionId = created.sessionId
      if (signal?.aborted === true) await client.cancel(sessionId)
      const result = await client.prompt(sessionId, prompt)
      void result
      if (signal?.aborted === true) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted by host', code: 'ABORTED' } } }
        return
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      failure = { message: `kiro side-channel turn failed: ${detail}`, code: classifyTurnError(detail) }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      await client.close().catch(() => undefined)
    }
    if (failure !== undefined && text.length === 0) {
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return
    }
    if (text.length === 0) {
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'kiro side-channel returned no content', code: 'EMPTY_RESPONSE' } },
      }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (let i = 0; i < text.length; i += 192) {
      yield { type: 'text-delta', index: 0, text: text.slice(i, i + 192) }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'usage',
      usage: {
        inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
        outputTokens: Math.max(1, Math.ceil(text.length / 4)),
      },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** Tear down every warm inner session (plugin dispose). */
  close(): void {
    this.sessions.closeAll()
  }
}

interface ContinuationPlan {
  /** Text to feed the inner session this turn, or null for a pure continuation. */
  feed: string | null
  /** Whether the warm session must be rebuilt (history diverged past repair). */
  rebuild: boolean
}

/**
 * Decide what to feed on a continuation request. The previous list must be a
 * prefix (same length growth, index 0 untouched, at most two in-place
 * mutations — the host refreshes runtime-context snapshots in place every
 * turn). Tail tool-result messages were already resolved into parked handlers
 * and never feed; fresh user turns and mutated messages do.
 */
export function planContinuation(previous: readonly Message[], current: readonly Message[]): ContinuationPlan {
  if (current.length <= previous.length) return { feed: null, rebuild: true }
  const mutated: number[] = []
  for (let i = 0; i < previous.length; i++) {
    if (JSON.stringify(previous[i]) !== JSON.stringify(current[i])) mutated.push(i)
  }
  if (mutated.includes(0) || mutated.length > 2) return { feed: null, rebuild: true }
  const tail = current.slice(previous.length)
  const freshUser = tail.filter(m => m.role === 'user' && m.source.kind !== 'tool')
  if (freshUser.length === 0 && mutated.length === 0) return { feed: null, rebuild: false }
  const parts: string[] = []
  for (const index of mutated) {
    const message = current[index]
    if (message !== undefined) parts.push(renderRefreshed(message))
  }
  for (const message of freshUser) parts.push(renderUserTurn(message.content))
  return { feed: parts.join('\n\n'), rebuild: false }
}
