/**
 * Minimal Agent Client Protocol (ACP) client driving `kiro-cli acp` over
 * stdio NDJSON JSON-RPC 2.0. The CLI emits Rust log lines on the same
 * stream, so non-JSON lines are skipped; server→client requests other than
 * `session/request_permission` are answered with method-not-found so the
 * agent never blocks on a capability this client does not implement.
 * @module dsh-llm-kiro/acp
 */

import { spawn, type ChildProcess } from 'node:child_process'

/** One `session/update` notification payload (shape kept structural). */
export interface AcpSessionUpdate {
  sessionUpdate: string
  content?: { type?: string, text?: string }
  toolCallId?: string
  status?: string
  title?: string
  rawInput?: unknown
  _meta?: { kiro?: { toolName?: string, mcpServerName?: string } }
}

/** Params of a `session/request_permission` server→client request. */
export interface AcpPermissionParams {
  sessionId?: string
  toolCall?: {
    toolCallId?: string
    title?: string
    rawInput?: unknown
    _meta?: { kiro?: { toolName?: string, mcpServerName?: string } }
  }
  options?: Array<{ optionId?: string, id?: string, name?: string, kind?: string }>
}

/** Params of the kiro-specific `_kiro.dev/metadata` notification. */
export interface AcpMetadata {
  sessionId?: string
  contextUsagePercentage?: number
  meteringUsage?: Array<{ value: number, unit: string, unitPlural?: string }>
  turnDurationMs?: number
}

/** MCP server descriptor accepted by `session/new` (HTTP transport). */
export interface AcpMcpServer {
  name: string
  type: 'http'
  url: string
  headers: Array<{ name: string, value: string }>
}

/** Decision the session layer makes for one permission request. */
export type PermissionDecision = 'allow' | 'deny'

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  method: string
}

export interface AcpClientOptions {
  /** kiro-cli executable (default `kiro-cli`). */
  cliPath?: string
  /** Model id passed as `--model` at spawn. */
  model?: string
  /** Reasoning effort passed as `--effort` at spawn. */
  effort?: string
  /** Extra CLI args appended after the managed ones. */
  extraArgs?: readonly string[]
}

const SPAWN_INIT_TIMEOUT_MS = 30_000

/**
 * One `kiro-cli acp` subprocess. Requests are serialised by the CLI per
 * session; this client multiplexes them by id and surfaces notifications
 * through the `on*` callbacks.
 */
export class AcpClient {
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stdoutBuf = ''
  /** Ring buffer of recent stderr / non-JSON stdout lines for diagnostics. */
  private readonly diag: string[] = []
  private exited = false
  private exitError: Error | null = null

  /** session/update notification (params.update). */
  onUpdate: ((sessionId: string, update: AcpSessionUpdate) => void) | undefined
  /** `_kiro.dev/metadata` notification. */
  onMetadata: ((metadata: AcpMetadata) => void) | undefined
  /** Decide allow/deny for `session/request_permission`. */
  onPermissionRequest: ((params: AcpPermissionParams) => PermissionDecision) | undefined
  /** Process exited (or failed to spawn); every pending request rejects. */
  onExit: ((error: Error) => void) | undefined

  constructor(private readonly options: AcpClientOptions = {}) {}

  /** Spawn the subprocess and complete the ACP initialize handshake. */
  async start(): Promise<void> {
    if (this.child !== null) throw new Error('acp client already started')
    const args = ['acp', '--trust-tools=']
    if (this.options.model !== undefined) args.push('--model', this.options.model)
    if (this.options.effort !== undefined) args.push('--effort', this.options.effort)
    if (this.options.extraArgs !== undefined) args.push(...this.options.extraArgs)
    const child = spawn(this.options.cliPath ?? 'kiro-cli', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr?.on('data', (chunk: string) => this.rememberDiag(chunk))
    child.on('error', (error) => this.onProcessExit(error))
    child.on('exit', (code, signal) => {
      this.onProcessExit(new Error(`kiro-cli acp exited (code=${String(code)}, signal=${String(signal)})`))
    })
    await this.requestWithTimeout('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    }, SPAWN_INIT_TIMEOUT_MS)
  }

  /** Create a fresh kiro session. */
  async newSession(cwd: string, mcpServers: readonly AcpMcpServer[]): Promise<{ sessionId: string }> {
    const result = await this.requestWithTimeout('session/new', {
      cwd,
      mcpServers: mcpServers.map(server => ({
        name: server.name,
        type: server.type,
        url: server.url,
        headers: server.headers,
      })),
    }, SPAWN_INIT_TIMEOUT_MS) as { sessionId?: string }
    if (typeof result.sessionId !== 'string' || result.sessionId.length === 0) {
      throw new Error('kiro session/new returned no sessionId')
    }
    return { sessionId: result.sessionId }
  }

  /**
   * Resume a persisted kiro session (survives CLI restarts). Only used for
   * potential future continuity paths; the adapter rebuilds instead.
   */
  async loadSession(sessionId: string, cwd: string, mcpServers: readonly AcpMcpServer[]): Promise<void> {
    await this.requestWithTimeout('session/load', {
      sessionId,
      cwd,
      mcpServers: mcpServers.map(server => ({
        name: server.name,
        type: server.type,
        url: server.url,
        headers: server.headers,
      })),
    }, SPAWN_INIT_TIMEOUT_MS)
  }

  /**
   * Run one prompt turn. The returned promise resolves only when the whole
   * turn settles — including MCP tool rounds whose responses this client
   * waits on — so updates flow through {@link onUpdate} in the meantime.
   */
  prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    return this.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    }) as Promise<{ stopReason: string }>
  }

  /** Best-effort cancellation of the in-flight prompt on one session. */
  async cancel(sessionId: string): Promise<void> {
    this.notify('session/cancel', { sessionId })
  }

  /** Kill the subprocess; pending requests reject via onExit. */
  async close(): Promise<void> {
    const child = this.child
    this.child = null
    if (child === null) return
    try { child.stdin?.end() } catch { /* already closed */ }
    const killed = new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* already dead */ }
        resolve()
      }, 3_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    try { child.kill('SIGTERM') } catch { /* already dead */ }
    await killed
  }

  /** Recent stderr / non-protocol lines, for error messages. */
  diagnostics(): string {
    return this.diag.slice(-10).join('\n')
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child
    if (child === null || this.exited) {
      return Promise.reject(this.exitError ?? new Error('acp client is not running'))
    }
    const id = this.nextId++
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      child.stdin?.write(message + '\n', (error) => {
        if (error != null) {
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  private requestWithTimeout(method: string, params: unknown, ms: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`kiro acp ${method} timed out after ${ms}ms`))
      }, ms)
      this.request(method, params).then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error: unknown) => { clearTimeout(timer); reject(error as Error) },
      )
    })
  }

  private notify(method: string, params: unknown): void {
    try {
      this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    } catch { /* process is going away; cancellation is best-effort */ }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let newline = this.stdoutBuf.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuf.slice(0, newline).trim()
      this.stdoutBuf = this.stdoutBuf.slice(newline + 1)
      if (line.length > 0) this.onLine(line)
      newline = this.stdoutBuf.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let message: {
      id?: number | string
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: { code?: number, message?: string }
    }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      // kiro-cli writes Rust log lines to stdout under -vv; skip them.
      this.rememberDiag(line)
      return
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(Number(message.id))
      if (entry === undefined) return
      this.pending.delete(Number(message.id))
      if (message.error !== undefined) {
        entry.reject(new Error(`kiro acp ${entry.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`))
      } else {
        entry.resolve(message.result)
      }
      return
    }
    if (message.method === undefined) return
    if (message.id !== undefined) {
      // The id is echoed verbatim: kiro's server→client request ids are not
      // necessarily numeric, and coercing them (e.g. NaN → null) would make
      // the response unmatchable and wedge the agent mid-turn.
      this.onServerRequest(message.id, message.method, message.params ?? {})
      return
    }
    this.onNotification(message.method, message.params ?? {})
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'session/update') {
      const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
      const update = params.update as AcpSessionUpdate | undefined
      if (update !== undefined) this.onUpdate?.(sessionId, update)
      return
    }
    if (method === '_kiro.dev/metadata') {
      this.onMetadata?.(params as unknown as AcpMetadata)
      return
    }
    // _kiro.dev/commands/available, _kiro.dev/subagent/list_update, ...: ignore.
  }

  private onServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method === 'session/request_permission') {
      const decision = this.onPermissionRequest?.(params as unknown as AcpPermissionParams) ?? 'deny'
      const options = (params as unknown as AcpPermissionParams).options ?? []
      const wanted = decision === 'allow' ? /allow/i : /reject|deny/i
      const fallback = decision === 'allow' ? /reject|deny/i : /allow/i
      const pick = (re: RegExp) => options.find(option =>
        re.test(option.kind ?? '') || re.test(option.name ?? '') || re.test(option.optionId ?? option.id ?? ''))
      const option = pick(wanted) ?? pick(fallback) ?? options[0]
      const optionId = option?.optionId ?? option?.id
      this.reply(id, optionId === undefined
        ? { outcome: { outcome: 'cancelled' } }
        : { outcome: { outcome: 'selected', optionId } })
      return
    }
    // Unknown server→client request: fail it so the agent never blocks.
    this.replyError(id, -32601, `client does not implement ${method}`)
  }

  private reply(id: number | string, result: unknown): void {
    try {
      this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
    } catch { /* process is going away */ }
  }

  private replyError(id: number | string, code: number, message: string): void {
    try {
      this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
    } catch { /* process is going away */ }
  }

  private rememberDiag(line: string): void {
    for (const part of line.split('\n')) {
      const trimmed = part.trim()
      if (trimmed.length === 0) continue
      this.diag.push(trimmed)
      if (this.diag.length > 50) this.diag.shift()
    }
  }

  private onProcessExit(error: Error): void {
    if (this.exited) return
    this.exited = true
    this.exitError = error
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
    this.onExit?.(error)
  }
}
