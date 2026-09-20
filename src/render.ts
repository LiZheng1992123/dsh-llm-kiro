/**
 * Render harness messages into the plain-text turns fed to the inner Kiro
 * session. Tool calls and results need no protocol here — they travel
 * through the MCP HTTP bridge — so this layer only handles conversational
 * context: the host system prompt, user turns, and (for full rebuilds)
 * prior history as compact text.
 * @module dsh-llm-kiro/render
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

/**
 * Tool-name prefix kiro-cli gives the host bridge's MCP tools
 * (`mcp__<server>__<tool>`); defined locally to avoid a session.ts import cycle.
 */
const MCP_TOOL_PREFIX = 'mcp__dsh-host__'

/** Render one content-block list as plain text; non-text blocks get placeholders. */
export function renderBlocks(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text': parts.push(block.text); break
      case 'reasoning': break
      case 'image': parts.push('[图片附件]'); break
      case 'tool-call': parts.push(`[调用了工具 ${block.name}(${block.arguments})]`); break
      case 'tool-result': {
        parts.push(`[工具结果 ${block.toolCallId}] ${renderBlocks(block.content)}`)
        break
      }
      default: parts.push(JSON.stringify(block))
    }
  }
  return parts.join('\n')
}

/** Render one message with its role tag. */
export function renderMessage(message: Message): string {
  const text = renderBlocks(message.content)
  switch (message.role) {
    case 'system': return `[系统提示] ${text}`
    case 'user': return `[用户] ${text}`
    case 'assistant': return `[助手] ${text}`
  }
}

/** Preamble establishing the inner model's role as this agent's LLM backend. */
const BACKEND_ROLE = [
  '你在为一个编码 agent（宿主）充当 LLM API 后端：宿主把它的对话喂给你，你只输出"下一条助手回复"本身。',
  '宿主的工具已经通过 MCP 挂进来，需要用工具时直接调用，不要描述你会在别的环境里怎么调。',
  `只允许调用名为 \`${MCP_TOOL_PREFIX}\` 前缀（即宿主桥接）的工具；你自己内置的工具（webSearch、webFetch、readFile、writeFile、editFile、bash、glob、grep、listDirectory 等）一律会被权限门自动拒绝（"User denied tool execution"），不要调用它们。宿主提示词里提到的工具名（如 web_search）指的是桥接工具，不是你的同名内置工具。`,
  '不要复述对话，不要解释你的角色。',
].join('\n')

/**
 * Compose the first feed for a fresh session: backend role, the host system
 * prompt, and the existing conversation as compact context.
 */
export function renderInitialFeed(system: string | undefined, messages: readonly Message[]): string {
  const parts: string[] = [BACKEND_ROLE]
  if (system !== undefined && system.length > 0) {
    parts.push(`---- 宿主系统提示（作为你的行为准则） ----\n${system}`)
  }
  const history = messages.map(renderMessage).filter(part => part.length > 0)
  if (history.length > 0) parts.push(`---- 宿主对话记录 ----\n${history.join('\n\n')}`)
  parts.push('---- 以上是背景。输出下一条助手回复。 ----')
  return parts.join('\n\n')
}

/** Render a brand-new host user turn. */
export function renderUserTurn(blocks: readonly ContentBlock[]): string {
  return `[用户] ${renderBlocks(blocks)}`
}

/** Render an in-place-updated message (runtime-context snapshots and the like). */
export function renderRefreshed(message: Message): string {
  return `${renderMessage(message)}\n（宿主原位刷新了这条消息）`
}

/** Render a host system-prompt update mid-session. */
export function renderSystemUpdate(system: string): string {
  return `[系统提示(更新)] ${system}`
}
