// End-to-end smoke test: drive KiroAdapter like the harness would.
// Turn 1: model must call the host_echo tool through the MCP bridge.
// Turn 2: host delivers the tool result; model must quote it back.
// Turn 3: pure-text continuation (delta feed path).
import { KiroAdapter } from './lib/index.js'

const adapter = new KiroAdapter({})
const MODEL = 'gpt-5.6-luna'

console.log('== listModels ==')
const models = await adapter.listModels('kiro')
console.log(models.map(m => `${m.id}${m.description ? '' : ''}`).join(', '))
const resolved = await adapter.resolveModel('kiro', MODEL)
console.log('resolved:', JSON.stringify(resolved))

const tools = [{
  name: 'host_echo',
  description: 'Echo back the given text (host tool bridge test)',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}]

let messages = [{
  role: 'user',
  content: [{ type: 'text', text: "Call the host_echo tool with text='smoke-kiro-42'. Do not answer until you have the tool result, then reply with exactly what the tool returned." }],
  source: { kind: 'user' },
}]

async function runTurn(label) {
  console.log(`\n== ${label} ==`)
  const t0 = Date.now()
  const toolCalls = []
  let text = ''
  let finish
  for await (const chunk of adapter.stream({ model: MODEL, messages, tools, sessionId: 'smoke-1' })) {
    if (chunk.type === 'text-delta') { text += chunk.text; process.stdout.write(chunk.text) }
    else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') toolCalls.push(chunk.block)
    else if (chunk.type === 'usage') console.log(`\n[usage] ${JSON.stringify(chunk.usage)}`)
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  console.log(`[finish] ${JSON.stringify(finish)} (${Date.now() - t0}ms)`)
  return { toolCalls, text, finish }
}

const overall = setTimeout(() => { console.error('\nOVERALL TIMEOUT'); process.exit(2) }, 300_000)

// Turn 1: expect a tool call.
const t1 = await runTurn('turn 1 (expect tool-call)')
if (t1.finish?.kind !== 'tool-calls' || t1.toolCalls.length === 0) {
  console.error('FAIL: expected tool-calls finish with at least one tool call')
  process.exit(1)
}
const call = t1.toolCalls[0]
console.log('[tool-call]', call.id, call.name, call.arguments)

// Host executes the tool and appends assistant + tool-result messages.
const resultText = `HOST-RESULT:${JSON.parse(call.arguments).text}`
messages = [
  ...messages,
  { role: 'assistant', content: t1.toolCalls.map(c => ({ type: 'tool-call', id: c.id, name: c.name, arguments: c.arguments })), source: { kind: 'assistant' } },
  { role: 'user', content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: resultText }] }], source: { kind: 'tool' } },
]

// Turn 2: model continues with the delivered result.
const t2 = await runTurn('turn 2 (tool result delivered)')
if (t2.finish?.kind !== 'stop' || !t2.text.includes('HOST-RESULT:smoke-kiro-42')) {
  console.error('FAIL: expected stop with the tool result quoted')
  process.exit(1)
}

// Turn 3: pure user continuation (incremental feed path).
messages = [
  ...messages,
  { role: 'assistant', content: [{ type: 'text', text: t2.text }], source: { kind: 'assistant' } },
  { role: 'user', content: [{ type: 'text', text: 'What was the exact tool result string you received earlier? Answer with just that string.' }], source: { kind: 'user' } },
]
const t3 = await runTurn('turn 3 (continuation, warm session memory)')
if (t3.finish?.kind !== 'stop' || !t3.text.includes('HOST-RESULT:smoke-kiro-42')) {
  console.error('FAIL: warm session did not remember the tool result')
  process.exit(1)
}

// Side channel (title/compaction style).
console.log('\n== side-channel cold stream ==')
let side = ''
for await (const chunk of adapter.stream({ model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: '用四个字总结：工具桥测试成功' }], source: { kind: 'user' } }], purpose: 'title' })) {
  if (chunk.type === 'text-delta') { side += chunk.text; process.stdout.write(chunk.text) }
}
if (side.length === 0) { console.error('FAIL: side-channel returned nothing'); process.exit(1) }

adapter.close()
clearTimeout(overall)
console.log('\n\nSMOKE TEST PASSED')
process.exit(0)
