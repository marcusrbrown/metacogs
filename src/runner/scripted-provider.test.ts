import { afterEach, describe, expect, test } from 'bun:test'

import { SPIKE_MODEL_ID, SPIKE_PROVIDER_ID, scriptedProviderConfig, startScriptedProvider, type ScriptedProviderServer, type ScriptedStep } from './scripted-provider'

const servers: ScriptedProviderServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop()
})

type Message = { role: string; content?: string; tool_calls?: { id: string }[]; tool_call_id?: string }
const MAIN_PROMPT = 'You are opencode, an interactive CLI tool.'
const TITLE_PROMPT = 'You are a title generator. You output ONLY a thread title.'
const TOOLS = [{ type: 'function', function: { name: 'metacogs_feel' } }]

const call = (name: string): ScriptedStep => ({ toolCalls: [{ id: `call-${name}`, name, arguments: { n: name } }] })
const user = (content: string): Message => ({ role: 'user', content })
const toolRound = (name: string): Message[] => [
  { role: 'assistant', tool_calls: [{ id: `call-${name}` }] },
  { role: 'tool', tool_call_id: `call-${name}`, content: 'result' },
]
const answer: Message = { role: 'assistant', content: 'done' }

/** What the stub answered: the tool call names and the text, read back from the SSE stream. */
async function ask(server: ScriptedProviderServer, messages: Message[], options: { tools?: boolean } = {}) {
  const res = await fetch(`${server.url}/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ messages, ...(options.tools ? { tools: TOOLS } : {}) }),
  })
  const chunks = (await res.text())
    .split('\n\n')
    .filter((c) => c.startsWith('data: {'))
    .map((c) => JSON.parse(c.slice(6)) as { choices: { delta: { content?: string; tool_calls?: { function: { name: string } }[] } }[] })
  const deltas = chunks.flatMap((c) => c.choices.map((ch) => ch.delta))
  return {
    calls: deltas.flatMap((d) => d.tool_calls?.map((t) => t.function.name) ?? []),
    text: deltas.map((d) => d.content ?? '').join(''),
  }
}

const start = (options: Parameters<typeof startScriptedProvider>[0]) => {
  const server = startScriptedProvider(options)
  servers.push(server)
  return server
}

describe('title and main requests', () => {
  test('a request with no tools and a non-main system prompt is the title request', async () => {
    const server = start({ steps: [call('metacogs_feel')] })
    expect(await ask(server, [{ role: 'system', content: TITLE_PROMPT }, user('Generate a title')])).toEqual({ calls: [], text: 'spike title' })
  })

  test('a main request with no tools is answered from the main script, not as a title', async () => {
    const server = start({ steps: [{ text: 'step zero' }], finalText: 'the end' })
    expect(await ask(server, [{ role: 'system', content: MAIN_PROMPT }, user('hi')])).toEqual({ calls: [], text: 'step zero' })
    expect(await ask(server, [{ role: 'system', content: MAIN_PROMPT }, user('hi'), ...toolRound('x')])).toEqual({ calls: [], text: 'the end' })
  })

  test('a tool-capable request is answered from the script whatever its system prompt says', async () => {
    const server = start({ steps: [call('metacogs_feel')] })
    expect((await ask(server, [{ role: 'system', content: 'You are an agent.' }, user('hi')], { tools: true })).calls).toEqual(['metacogs_feel'])
  })

  test('the main-prompt check is case-insensitive and applies to any system message', async () => {
    const server = start({ steps: [{ text: 'main' }] })
    expect((await ask(server, [{ role: 'system', content: 'You are OpenCode, the best coding agent.' }, user('hi')])).text).toBe('main')
    expect((await ask(server, [{ role: 'system', content: 'preamble' }, { role: 'system', content: MAIN_PROMPT }, user('hi')])).text).toBe('main')
  })

  test('requests record whether they were main', async () => {
    const server = start({ steps: [] })
    await ask(server, [{ role: 'system', content: TITLE_PROMPT }, user('t')])
    await ask(server, [{ role: 'system', content: MAIN_PROMPT }, user('hi')])
    expect(server.requests.map((r) => r.main)).toEqual([false, true])
  })
})

describe('steps by round (existing behaviour)', () => {
  test('round counts every completed tool round in the history', async () => {
    const server = start({ steps: [call('a'), call('b')], finalText: 'end' })
    const system: Message = { role: 'system', content: MAIN_PROMPT }
    expect((await ask(server, [system, user('hi')], { tools: true })).calls).toEqual(['a'])
    expect((await ask(server, [system, user('hi'), ...toolRound('a')], { tools: true })).calls).toEqual(['b'])
    expect((await ask(server, [system, user('hi'), ...toolRound('a'), ...toolRound('b')], { tools: true })).text).toBe('end')
    expect(server.requests.map((r) => r.round)).toEqual([0, 1, 2])
  })
})

describe('steps by turn and round', () => {
  const system: Message = { role: 'system', content: MAIN_PROMPT }

  test('turn 2 runs its own script from step 0, so turn 1 can call one tool and turn 2 another', async () => {
    const server = start({ steps: [], turns: [[call('metacogs_feel')], [call('metacogs_drugs')]], finalText: 'end' })
    const turn1 = [system, user('first')]
    expect((await ask(server, turn1, { tools: true })).calls).toEqual(['metacogs_feel'])
    const afterFeel = [...turn1, ...toolRound('metacogs_feel')]
    expect((await ask(server, afterFeel, { tools: true })).text).toBe('end')

    const turn2 = [...afterFeel, answer, user('second')]
    expect((await ask(server, turn2, { tools: true })).calls).toEqual(['metacogs_drugs'])
    expect((await ask(server, [...turn2, ...toolRound('metacogs_drugs')], { tools: true })).text).toBe('end')
  })

  test('rounds are counted after the last user message, and the request records its turn and turn round', async () => {
    const server = start({ steps: [], turns: [[call('a')], [call('b'), call('c')]], finalText: 'end' })
    const turn2 = [system, user('one'), ...toolRound('a'), answer, user('two')]
    expect((await ask(server, turn2, { tools: true })).calls).toEqual(['b'])
    expect((await ask(server, [...turn2, ...toolRound('b')], { tools: true })).calls).toEqual(['c'])
    expect(server.requests.map((r) => [r.turn, r.turnRound, r.round])).toEqual([
      [1, 0, 1],
      [1, 1, 2],
    ])
  })

  test('a turn past the end of the script answers the final text', async () => {
    const server = start({ steps: [], turns: [[call('a')]], finalText: 'end' })
    expect((await ask(server, [system, user('one'), answer, user('two')], { tools: true })).text).toBe('end')
  })

  test('a zero-tool main request follows the turn script too', async () => {
    const server = start({ steps: [], turns: [[{ text: 'first' }], [{ text: 'second' }]] })
    expect((await ask(server, [system, user('one')])).text).toBe('first')
    expect((await ask(server, [system, user('one'), answer, user('two')])).text).toBe('second')
  })

  test('the title request is never scripted, even with turns', async () => {
    const server = start({ steps: [], turns: [[call('a')]] })
    expect((await ask(server, [{ role: 'system', content: TITLE_PROMPT }, user('Generate a title'), user('one')])).text).toBe('spike title')
  })
})

describe('scriptedProviderConfig', () => {
  const models = (config: Record<string, unknown>) => (config[SPIKE_PROVIDER_ID] as { models: Record<string, { id: string }> }).models

  test('the default model id is the spike model', () => {
    expect(Object.keys(models(scriptedProviderConfig('http://x/v1')))).toEqual([SPIKE_MODEL_ID])
  })

  test("a model id stands in for a model family and is the model entry's id", () => {
    const entry = models(scriptedProviderConfig('http://x/v1', 'gpt-scripted'))
    expect(Object.keys(entry)).toEqual(['gpt-scripted'])
    expect(entry['gpt-scripted']?.id).toBe('gpt-scripted')
  })
})
