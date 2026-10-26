import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { INTERNAL_REQUEST_SIGNATURES } from '../runner/scripted-provider'
import { GUIDANCE_BLOCK, GUIDANCE_CLOSE, GUIDANCE_OPEN, GUIDANCE_TEXT, INTERNAL_SIGNATURES, stripGuidance, withGuidance } from './guidance'

const countBlocks = (system: readonly string[]) => system.join('\n').split(GUIDANCE_OPEN).length - 1

describe('the embedded text', () => {
  test('is the raw markdown file: it starts with its heading and has no HTML', () => {
    expect(GUIDANCE_TEXT).toBe(readFileSync(new URL('../../plugin/guidance.md', import.meta.url), 'utf8'))
    expect(GUIDANCE_TEXT.startsWith('# metacogs\n')).toBe(true)
    expect(GUIDANCE_TEXT).not.toContain('<p>')
  })

  test('names both tools with the "if available" wording, the two skills, and rules out routine coding', () => {
    expect(GUIDANCE_TEXT).toContain('If `metacogs_feel` is available')
    expect(GUIDANCE_TEXT).toContain('If `metacogs_drugs` is available')
    expect(GUIDANCE_TEXT).toContain('`synthesis`')
    expect(GUIDANCE_TEXT).toContain('`counterfactual`')
    expect(GUIDANCE_TEXT).toMatch(/Do not use any of them for routine coding/)
  })

  test('contains no marker and no internal-request signature of its own', () => {
    expect(GUIDANCE_TEXT).not.toContain(GUIDANCE_OPEN)
    expect(GUIDANCE_TEXT).not.toContain(GUIDANCE_CLOSE)
    for (const signature of INTERNAL_SIGNATURES) expect(GUIDANCE_TEXT.toLowerCase()).not.toContain(signature.toLowerCase())
  })

  test('the block wraps the text in the markers', () => {
    expect(GUIDANCE_BLOCK).toBe(`${GUIDANCE_OPEN}\n${GUIDANCE_TEXT.trimEnd()}\n${GUIDANCE_CLOSE}`)
  })
})

describe('the internal-request signatures', () => {
  test('are the list the runner uses to tell the host\'s own calls from the main request', () => {
    expect([...INTERNAL_SIGNATURES].map((s) => s.toLowerCase())).toEqual([...INTERNAL_REQUEST_SIGNATURES])
  })
})

describe('withGuidance', () => {
  const main = ['You are opencode, an interactive CLI tool.']

  test('appends exactly one block to system[0]', () => {
    const next = withGuidance(main)
    expect(next).toEqual([`${main[0]}\n\n${GUIDANCE_BLOCK}`])
    expect(countBlocks(next ?? [])).toBe(1)
  })

  test('leaves later entries alone', () => {
    expect(withGuidance(['one', 'two'])).toEqual([`one\n\n${GUIDANCE_BLOCK}`, 'two'])
  })

  test('is idempotent: a second pass over its own output is byte-identical', () => {
    const once = withGuidance(main) ?? []
    expect(withGuidance(once)).toEqual(once)
    expect(withGuidance(withGuidance(once) ?? [])).toEqual(once)
  })

  test('strips a block from any entry before appending one', () => {
    const next = withGuidance([`one\n\n${GUIDANCE_BLOCK}`, `two\n\n${GUIDANCE_BLOCK}`]) ?? []
    expect(next).toEqual([`one\n\n${GUIDANCE_BLOCK}`, 'two'])
    expect(countBlocks(next)).toBe(1)
  })

  test('an empty system gets the block as its only entry; an empty first entry becomes the block', () => {
    expect(withGuidance([])).toEqual([GUIDANCE_BLOCK])
    expect(withGuidance([''])).toEqual([GUIDANCE_BLOCK])
  })

  test('does not mutate its input', () => {
    const input = ['a', 'b']
    withGuidance(input)
    expect(input).toEqual(['a', 'b'])
  })

  test.each([
    ['title', 'You are a title generator. You output ONLY a thread title. Nothing else.'],
    ['compaction', 'You are a context summarization agent. You are given a conversation between a user and an agent.'],
    ['session summary', 'Summarize what was done in this conversation. Write like a pull request description.'],
    ["Systematic's summary signature", 'You are a helpful AI assistant tasked with summarizing conversations'],
  ])('a %s request gets no block', (_name, text) => {
    expect(withGuidance([text])).toBeNull()
    expect(withGuidance(['preamble', text.toUpperCase()])).toBeNull()
  })

  test('a signature inside a block this plugin appended earlier does not count', () => {
    expect(withGuidance([`x\n\n${GUIDANCE_OPEN}\nYou are a title generator\n${GUIDANCE_CLOSE}`])).toEqual([`x\n\n${GUIDANCE_BLOCK}`])
  })
})

describe('stripGuidance', () => {
  test('removes every closed block and the separator before it', () => {
    expect(stripGuidance(`a\n\n${GUIDANCE_BLOCK}`)).toBe('a')
    expect(stripGuidance(`${GUIDANCE_BLOCK}`)).toBe('')
    expect(stripGuidance(`a\n\n${GUIDANCE_BLOCK}\n\nb\n\n${GUIDANCE_BLOCK}`)).toBe('a\n\nb')
  })

  test('leaves text without a closed block untouched, an open marker included', () => {
    expect(stripGuidance('plain')).toBe('plain')
    expect(stripGuidance(`a ${GUIDANCE_OPEN} never closed`)).toBe(`a ${GUIDANCE_OPEN} never closed`)
  })
})
