/**
 * The view scans and transforms every text it keeps any part of in full, before it cuts. A secret that needs its closing context to be
 * recognised (a long quoted key value, a JWT with long segments, an address written with layers of escapes) must be withheld when it
 * runs across any position of the text, and no 16-character run of it may reach the view or a request. Each case goes through the
 * rendered view and the real pre-send guard. Texts over the bounds are withheld without being scanned, and the worst case that is
 * scanned finishes in seconds.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { RENDER_LIMITS, SCRUB_PLACEHOLDER } from './mask'
import { inputHoldsSecret, SCRUB_LIMITS, SCRUB_LIMIT_RULE, scrubFindings } from './scrub'
import { assertWithheld, cleanup, randomText, viewOf } from './view-support'

afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

const random = randomText

/** The old scan boundary: a secret that starts before it and ends after it was cut by a window there. */
const OLD_BOUNDARY = 8192

// Built from parts, so this file holds no key-shaped literal.
const KEY_VALUE = random(9600, 7)
const KEY_TEXT = JSON.stringify({ [['k', 'ey'].join('')]: KEY_VALUE })
const JWT = `eyJ${random(9000, 11)}.eyJ${random(60, 13)}.${random(40, 17)}`
const LOCAL = ['zq8user', 'abcdefghijklmnop'].join('')
const ADDRESS = `${LOCAL}@${['corp', 'mail.com'].join('-')}`
/** Every character written as a unicode escape, and the backslashes doubled twice: an address with layers of escaping. */
const layers = (text: string, count: number): string => {
  let out = [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  for (let i = 1; i < count; i++) out = out.replace(/\\/g, '\\\\')
  return out
}
const ENCODED = layers(ADDRESS, 3)

type Kind = 'stimulus' | 'input' | 'output'
const KINDS: readonly Kind[] = ['stimulus', 'input', 'output']
/** The text before a tool input's `content`, in its serialization. */
const INPUT_PREFIX = '{"content":"'.length

/** Words of two letters, so no run is long enough for a rule and no word is a key name; exactly `length` characters, ending in a space. */
const filler = (length: number): string => (length <= 0 ? '' : `${'ab cd '.repeat(Math.ceil(length / 6)).slice(0, length - 1)} `)

/** The call with `piece` at `start` of what the view renders (the serialization, for an input), on one line, short enough to be scanned. */
function callWith(kind: Kind, piece: string, start: number): { user?: string; input?: Record<string, unknown>; output?: string } {
  const at = kind === 'input' ? start - INPUT_PREFIX : start
  const text = `${filler(at)}${piece} ${filler(200)}`
  if (kind === 'stimulus') return { user: text }
  if (kind === 'input') return { input: { content: text } }
  return { output: text }
}

describe('a secret that needs its closing context is withheld wherever it lies', () => {
  const CASES: { name: string; piece: string; secrets: string[]; starts: number[] }[] = [
    { name: 'a long quoted key value', piece: KEY_TEXT, secrets: [KEY_VALUE], starts: [0, OLD_BOUNDARY - 5000, OLD_BOUNDARY - 1000] },
    { name: 'a JWT with a long first segment', piece: JWT, secrets: [JWT], starts: [0, OLD_BOUNDARY - 5000, OLD_BOUNDARY - 1000] },
    { name: 'an address written with layers of escapes', piece: ENCODED, secrets: [ADDRESS, ENCODED], starts: [OLD_BOUNDARY - 600, OLD_BOUNDARY - 150, OLD_BOUNDARY - 20] },
  ]

  for (const kind of KINDS) {
    for (const c of CASES) {
      test(`${kind}: ${c.name}, starting before the old boundary and ending after it`, async () => {
        for (const start of c.starts) {
          const call = callWith(kind, c.piece, start)
          await assertWithheld(call, c.secrets, `${kind} ${c.name} at ${start}`)
        }
      }, 120_000)
    }
  }

  test('the pieces really do span the old boundary', () => {
    expect(KEY_TEXT.length).toBeGreaterThan(OLD_BOUNDARY)
    expect(JWT.length).toBeGreaterThan(OLD_BOUNDARY)
    expect(OLD_BOUNDARY - 150 + ENCODED.length).toBeGreaterThan(OLD_BOUNDARY)
    expect(ENCODED.length).toBeGreaterThan(300)
  })

  test('the scrub itself finds each, in full, and an input that holds one is a secret', () => {
    for (const piece of [KEY_TEXT, JWT, ENCODED]) expect([piece.slice(0, 20), scrubFindings(piece).size > 0]).toEqual([piece.slice(0, 20), true])
    // an address alone is not a secret in an input: the serialization is checked after, and an address is replaced or the text withheld
    for (const piece of [KEY_TEXT, JWT]) expect(inputHoldsSecret({ content: `${filler(OLD_BOUNDARY - 100)}${piece}` })).toBe(true)
  })
})

describe('the bounds that keep the cost small', () => {
  /** Lines just under the line bound, joined by newlines, to exactly `total` characters. */
  const lines = (total: number): string => {
    const line = 'x'.repeat(SCRUB_LIMITS.line - 1)
    let text = line
    while (text.length < total) text += `\n${line}`
    return text.slice(0, total)
  }
  /** Generous: the measured time is about a third of it. The point is the order of magnitude, not the figure. */
  const WALL_MS = 6000

  test('the hard bound is the one that keeps the scan small', () => {
    expect(SCRUB_LIMITS).toEqual({ decodeDepth: 8, containerDepth: 64, nodes: 25_000, chars: 100_000, line: 20_000 })
  })

  test('a text at the hard bound, in lines just under the line bound, is scanned in full and finishes in time, in every kind', () => {
    for (const kind of KINDS) {
      const text = lines(SCRUB_LIMITS.chars)
      expect(text.length).toBe(SCRUB_LIMITS.chars)
      const started = performance.now()
      const { rendered } = viewOf(kind === 'stimulus' ? { user: text } : kind === 'output' ? { output: text } : { input: { content: text } })
      const elapsed = performance.now() - started
      expect([kind, elapsed < WALL_MS]).toEqual([kind, true])
      expect(rendered.scopes[0]?.stimuli.length).toBe(1)
    }
  }, 120_000)

  test('a text just over the hard bound is withheld without being scanned', () => {
    for (const kind of KINDS) {
      const text = lines(SCRUB_LIMITS.chars + 1)
      const started = performance.now()
      const { rendered } = viewOf(kind === 'stimulus' ? { user: text } : kind === 'output' ? { output: text } : { input: { content: text } })
      const elapsed = performance.now() - started
      // the one scan the view cannot skip is the walk of the store's own rows, which is small: far under a scan of the text
      expect([kind, JSON.stringify(rendered.scopes).includes(SCRUB_PLACEHOLDER)]).toEqual([kind, true])
      expect([kind, elapsed < 1500]).toEqual([kind, true])
    }
    const started = performance.now()
    expect(scrubFindings(lines(SCRUB_LIMITS.chars + 1)).has(SCRUB_LIMIT_RULE)).toBe(true)
    expect(performance.now() - started).toBeLessThan(500)
  }, 120_000)

  test('a line one over the line bound is withheld at once, wherever it lies in a text of short lines', () => {
    const text = `${lines(SCRUB_LIMITS.chars / 2)}\n${'y'.repeat(SCRUB_LIMITS.line + 1)}`
    expect(scrubFindings(text, { ...SCRUB_LIMITS, chars: 10_000_000 }).has(SCRUB_LIMIT_RULE)).toBe(true)
  }, 60_000)

  test('a text under every bound that holds a secret far into it is withheld', () => {
    const KEY = ['sk', 'ant', 'abcdefghijklmnopqrstuvwx'].join('-')
    const text = `${lines(60_000)}\n${KEY}\n${lines(10_000)}`
    expect(text.length).toBeLessThan(SCRUB_LIMITS.chars)
    const { rendered } = viewOf({ output: text })
    expect(JSON.stringify(rendered.scopes)).toContain(SCRUB_PLACEHOLDER)
    expect(JSON.stringify(rendered.scopes)).not.toContain(KEY)
    expect(RENDER_LIMITS.output).toBeLessThan(60_000)
  }, 60_000)
})
