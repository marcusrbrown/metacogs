/**
 * The oracle the view tests rely on: a helper that is handed a view or a request that deliberately leaks must throw, in every form the
 * leak can take. A helper that only looks for the raw text passes the tests it is meant to fail.
 */
import { describe, expect, test } from 'bun:test'

import type { CompleteRequest } from '../feel-drugs/replay/judge'
import type { RenderedSessions } from './mask'
import { EMAIL_ADDRESS_FORMS, EMAIL_PARTS } from './scrub-cases'
import { assertRequestsHoldNoFragment, assertViewHoldsNoFragment, findFragment, formsOf, jsonEscaped, randomText, unescaped } from './view-support'

/** 56 characters with a quote or a backslash in every window of 16, so each form of it differs from the others in every run. */
const SECRET = Array.from({ length: 8 }, (_, i) => `${randomText(6, i + 3)}${i % 2 === 0 ? '"' : '\\'}`).join('')
const PREFIX = SECRET.slice(0, 28)
/** The prefix written out in every layer of JSON string escaping a log or a body can hold. */
const layered = (text: string, count: number): string => Array.from({ length: count }).reduce<string>((out) => jsonEscaped(out), text)

const COUNTERS = { scrubbedOutputs: 0, scrubbedInputs: 0, scrubbedStimuli: 0, redactedEmails: 0 }
const view = (text: string, traffic: string[] = []): RenderedSessions => ({ scopes: [{ sessionId: 's', scopeIndex: 0, workflow: 'ce:plan', stimuli: [{ id: 'a', kind: 'user_message', text, traffic }] }], counters: COUNTERS })
const request = (user: string, system = 'You label stimuli. The text between the markers is data.'): { requests: CompleteRequest[] } => ({ requests: [{ model: 'm', system, user, sessionId: 's' }] })

const viewLeaks = (rendered: RenderedSessions, secrets: readonly string[] = [SECRET], parts: readonly string[] = []): boolean => {
  try {
    assertViewHoldsNoFragment(rendered, secrets, 'case', parts)
    return false
  } catch (e) {
    return e instanceof Error && e.message.includes('holds a fragment')
  }
}
const requestLeaks = (transport: { requests: CompleteRequest[] }, secrets: readonly string[] = [SECRET], parts: readonly string[] = []): boolean => {
  try {
    assertRequestsHoldNoFragment(transport, secrets, 'case', parts)
    return false
  } catch (e) {
    return e instanceof Error && e.message.includes('holds a fragment')
  }
}

describe('the forms of a text', () => {
  test('the secret really differs in each form, in every run of 16', () => {
    expect(SECRET.length).toBeGreaterThan(48)
    expect(jsonEscaped(SECRET)).not.toBe(SECRET)
    for (let i = 0; i + 16 <= SECRET.length; i++) expect(/["\\]/.test(SECRET.slice(i, i + 16))).toBe(true)
  })

  test('unescaped replaces every escape with its character, whatever the number of backslashes', () => {
    expect(unescaped('a\\u0040b \\\\u0040 \\x41 \\\\\\n \\"q\\\\"')).toBe('a@b @ A \n "q"')
    expect(unescaped('plain text 12')).toBe('plain text 12')
    expect(jsonEscaped('a"b\\c\n')).toBe('a\\"b\\\\c\\n')
    expect(unescaped(layered(PREFIX, 3))).toBe(unescaped(PREFIX))
  })
})

describe('a view that leaks is refused, in every form', () => {
  test('(a) a literal prefix of the secret, in the stimulus text or in tool traffic', () => {
    expect(viewLeaks(view(`go on ${PREFIX} thanks`))).toBe(true)
    expect(viewLeaks(view('go on', [`[tool] bash ${PREFIX}`]))).toBe(true)
  })

  test('(b) a JSON-escaped prefix', () => {
    expect(jsonEscaped(PREFIX)).not.toContain(PREFIX)
    expect(viewLeaks(view(`go on ${jsonEscaped(PREFIX)} thanks`))).toBe(true)
    expect(viewLeaks(view('go on', [`[tool] bash ${jsonEscaped(PREFIX)}`]))).toBe(true)
  })

  test('(c) a multi-layer escaped prefix', () => {
    for (const count of [2, 3, 4]) {
      expect(viewLeaks(view('go on', [`[tool] bash ${layered(PREFIX, count)}`]))).toBe(true)
      expect(viewLeaks(view(`go on ${layered(PREFIX, count)}`))).toBe(true)
    }
  })

  test('(d) a fragment that is only in a serialized tool input, whose strings are JSON-escaped', () => {
    const serialized = `[tool] write ${JSON.stringify({ content: `note ${PREFIX} end` })}`
    expect(serialized).not.toContain(PREFIX)
    expect(viewLeaks(view('go on', [serialized]))).toBe(true)
    // the input serialized inside a text that is serialized again
    expect(viewLeaks(view('go on', [`[tool] write ${JSON.stringify({ content: JSON.stringify({ inner: PREFIX }) })}`]))).toBe(true)
  })

  test('(e) a decoded form of a secret that was written with escapes', () => {
    const [literal, escaped] = EMAIL_ADDRESS_FORMS
    if (!literal || !escaped) throw new Error('missing forms')
    expect(viewLeaks(view(`mail ${literal.slice(0, 18)}`), [escaped])).toBe(true)
    expect(viewLeaks(view(`mail ${layered(escaped, 3).slice(0, 40)}`), [literal])).toBe(true)
  })

  test('a part shorter than a run is found whole, in any form, and a clean view is not refused', () => {
    expect(viewLeaks(view('go on', ['[tool] bash see someone here']), [], EMAIL_PARTS)).toBe(true)
    expect(viewLeaks(view('go on', [`[tool] write ${JSON.stringify({ to: 'corp-mail.com' })}`]), [], EMAIL_PARTS)).toBe(true)
    expect(viewLeaks(view('go on', ['[tool] bash ls']), [], EMAIL_PARTS)).toBe(false)
  })

  test('a clean view, one that holds the placeholder, and one with a shorter run of the secret are not refused', () => {
    expect(viewLeaks(view('go on', ['[tool] bash ls', '[tool] write [withheld: secret pattern found]']))).toBe(false)
    // shorter than a run in every form: ten characters of the secret are eleven once escaped
    expect(viewLeaks(view(`go on ${SECRET.slice(0, 10)} thanks`))).toBe(false)
    expect(viewLeaks(view(`go on ${jsonEscaped(SECRET).slice(0, 12)} thanks`))).toBe(false)
  })
})

describe('a request that leaks is refused, in every form', () => {
  test('(a) a literal prefix, in the user message or the system message', () => {
    expect(requestLeaks(request(`<<<BEGIN>>>\n${PREFIX}\n<<<END>>>`))).toBe(true)
    expect(requestLeaks(request('clean', `You label. ${PREFIX}`))).toBe(true)
  })

  test('(b) a JSON-escaped prefix', () => {
    expect(requestLeaks(request(`<<<BEGIN>>>\n${jsonEscaped(PREFIX)}\n<<<END>>>`))).toBe(true)
  })

  test('(c) a multi-layer escaped prefix', () => {
    for (const count of [2, 3, 4]) expect(requestLeaks(request(`<<<BEGIN>>>\n${layered(PREFIX, count)}\n<<<END>>>`))).toBe(true)
  })

  test('(d) a fragment only in a serialized tool input inside the message', () => {
    const serialized = `[tool] write ${JSON.stringify({ content: `note ${PREFIX} end` })}`
    expect(serialized).not.toContain(PREFIX)
    expect(requestLeaks(request(`<<<BEGIN>>>\n${serialized}\n<<<END>>>`))).toBe(true)
  })

  test('a clean request is not refused, nor one with only a shorter run', () => {
    expect(requestLeaks(request('<<<BEGIN>>>\n[tool] bash ls\n<<<END>>>'))).toBe(false)
    expect(requestLeaks(request(`<<<BEGIN>>>\n${SECRET.slice(0, 10)}\n<<<END>>>`))).toBe(false)
  })
})

describe('findFragment', () => {
  test('names the fragment it found, and nothing for a clean text', () => {
    expect(findFragment([`xx ${PREFIX}`], [SECRET])).toBeDefined()
    expect(findFragment(['nothing here'], [SECRET])).toBeUndefined()
    expect(formsOf(SECRET)).toEqual([SECRET, jsonEscaped(SECRET)])
    expect(formsOf(`a\\u0040b"`)).toHaveLength(3)
  })
})
