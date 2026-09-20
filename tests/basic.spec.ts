import { describe, expect, it } from 'vitest'
import { planContinuation } from '../src/adapter.ts'
import { KIRO_MODELS, resolveKiroModelId } from '../src/catalog.ts'
import { renderInitialFeed, renderRefreshed, renderUserTurn } from '../src/render.ts'
import { classifyTurnError, renderResultText } from '../src/session.ts'
import type { Message } from '@deepseek-ai/dsh-llm'

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } as Message
}

describe('resolveKiroModelId', () => {
  it('passes known ids through', () => {
    expect(resolveKiroModelId('glm-5')).toBe('glm-5')
  })
  it('strips a kiro- prefix for unknown ids', () => {
    expect(resolveKiroModelId('kiro-some-future-model')).toBe('some-future-model')
  })
  it('never strips a real catalog id that starts with kiro-', () => {
    // No current catalog id starts with kiro-, but the guard must hold if one appears.
    const fake = KIRO_MODELS[0]?.id ?? ''
    expect(resolveKiroModelId(fake)).toBe(fake)
  })
})

describe('render', () => {
  it('renders the initial feed with role, system and history', () => {
    const feed = renderInitialFeed('SYS', [user('hello')])
    expect(feed).toContain('SYS')
    expect(feed).toContain('[用户] hello')
    expect(feed).toContain('宿主对话记录')
  })
  it('steers the inner model away from kiro native tools', () => {
    const feed = renderInitialFeed(undefined, [])
    expect(feed).toContain('mcp__dsh-host__')
    expect(feed).toContain('webSearch')
    expect(feed).toContain('User denied tool execution')
  })
  it('renders user turns and refreshed messages', () => {
    expect(renderUserTurn([{ type: 'text', text: 'hi' }])).toBe('[用户] hi')
    expect(renderRefreshed(user('ctx'))).toContain('宿主原位刷新')
  })
  it('renders tool results as text for the inner model', () => {
    expect(renderResultText([{ type: 'text', text: 'ok' }])).toBe('ok')
  })
})

describe('planContinuation', () => {
  it('rebuilds when history shrank (compaction)', () => {
    const prev = [user('a'), user('b'), user('c')]
    const cur = [user('a')]
    expect(planContinuation(prev, cur).rebuild).toBe(true)
  })
  it('feeds only the fresh user turn on growth', () => {
    const prev = [user('a')]
    const cur = [user('a'), user('b')]
    const plan = planContinuation(prev, cur)
    expect(plan.rebuild).toBe(false)
    expect(plan.feed).toBe('[用户] b')
  })
  it('returns null feed for pure tool-result tails', () => {
    const prev = [user('a')]
    const toolMsg = {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'x', content: [{ type: 'text', text: 'r' }] }],
      source: { kind: 'tool' },
    } as unknown as Message
    const plan = planContinuation(prev, [...prev, toolMsg])
    expect(plan).toEqual({ feed: null, rebuild: false })
  })
  it('rebuilds when message 0 mutated or too many mutations', () => {
    const prev = [user('a'), user('b')]
    expect(planContinuation(prev, [user('A'), user('b'), user('c')]).rebuild).toBe(true)
    const many = [user('a'), user('b'), user('c'), user('d')]
    const mutated = [user('A'), user('B'), user('C'), user('d'), user('e')]
    expect(planContinuation(many, mutated).rebuild).toBe(true)
  })
})

describe('classifyTurnError', () => {
  it('maps context-window rejections', () => {
    expect(classifyTurnError('maximum context length exceeded: you requested 999999 tokens'))
      .toBe('CONTEXT_WINDOW_EXCEEDED')
  })
  it('falls through to a generic backend code', () => {
    expect(classifyTurnError('some random failure')).toBe('BACKEND_TURN_ERROR')
  })
})
