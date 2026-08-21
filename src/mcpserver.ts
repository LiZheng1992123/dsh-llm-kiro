/**
 * Per-session streamable-HTTP MCP server exposing the host's tools to the
 * inner kiro-cli agent. Host tool schemas pass through as raw JSON Schema
 * (no zod round-trip); `tools/call` is delegated to the session's park /
 * resume bridge so the model only ever sees host-executed results.
 * @module dsh-llm-kiro/mcpserver
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'

/** Result the bridge handler returns for one tool call. */
export interface McpToolResult {
  text: string
  isError: boolean
}

/** Session-supplied executor for `tools/call` (parks until the host replies). */
export type McpCallHandler = (name: string, args: Record<string, unknown>) => Promise<McpToolResult>

const MCP_PROTOCOL_VERSION = '2025-03-26'

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: { name?: string, arguments?: Record<string, unknown> }
}

/**
 * One loopback HTTP MCP server. Lifecycle: `start()` once (before the ACP
 * `session/new` referencing its URL), `close()` with the owning session.
 */
export class HostMcpServer {
  private server: http.Server | null = null
  private readonly tools = new Map<string, ToolSchema>()
  /** The active call handler; swapped per owning session, never per call. */
  handler: McpCallHandler | null = null

  /** Register (or replace) the advertised host tools. */
  ensureTools(tools: readonly ToolSchema[]): void {
    for (const schema of tools) {
      const hash = JSON.stringify(schema.parameters ?? {})
      const existing = this.tools.get(schema.name)
      if (existing !== undefined && JSON.stringify(existing.parameters ?? {}) === hash) continue
      this.tools.set(schema.name, schema)
    }
  }

  /** Bind on an ephemeral loopback port; resolves with the MCP URL. */
  async start(): Promise<string> {
    if (this.server !== null) throw new Error('mcp server already started')
    this.server = http.createServer((req, res) => { void this.onRequest(req, res) })
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(0, '127.0.0.1', resolve)
    })
    const address = this.server.address() as AddressInfo
    return `http://127.0.0.1:${address.port}/mcp`
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (server === null) return
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    await new Promise<void>(resolve => req.on('end', resolve))
    let message: JsonRpcMessage
    try {
      message = JSON.parse(body) as JsonRpcMessage
    } catch {
      res.writeHead(400).end()
      return
    }
    // Notifications (no id) need no response payload.
    if (message.id === undefined) {
      res.writeHead(202).end()
      return
    }
    const reply = (result: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id as number | string, result }))
    }
    const replyError = (code: number, text: string): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id as number | string, error: { code, message: text } }))
    }
    switch (message.method) {
      case 'initialize':
        reply({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh-host', version: '0.1.0' },
        })
        return
      case 'ping':
        reply({})
        return
      case 'tools/list':
        reply({
          tools: [...this.tools.values()].map(schema => ({
            name: schema.name,
            description: schema.description.length > 0 ? schema.description : schema.name,
            inputSchema: schema.parameters ?? { type: 'object', properties: {} },
          })),
        })
        return
      case 'tools/call': {
        const handler = this.handler
        const name = message.params?.name
        if (handler === null || name === undefined || !this.tools.has(name)) {
          replyError(-32602, `unknown tool: ${String(name)}`)
          return
        }
        try {
          const result = await handler(name, message.params?.arguments ?? {})
          reply({
            content: [{ type: 'text', text: result.text }],
            ...result.isError ? { isError: true } : {},
          })
        } catch (error) {
          reply({
            content: [{ type: 'text', text: `host tool bridge failed: ${String(error)}` }],
            isError: true,
          })
        }
        return
      }
      default:
        replyError(-32601, `unknown method: ${String(message.method)}`)
    }
  }
}
