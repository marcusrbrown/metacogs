/**
 * Where the view cuts a text: no fragment of an address survives the cut, a text is withheld rather than cut inside an escape, the
 * scan covers the kept text and a margin past it, and a very long line is withheld without being scanned. Each case goes through the
 * rendered view and the real pre-send guard.
 */
import { afterEach, describe, expect, test } from 'bun:test'

import { chunkScope, RENDER_LIMITS, SCRUB_PLACEHOLDER } from './mask'
import { holdsSecret, scrubFindings, SCRUB_LIMIT_RULE } from './scrub'
import { CREDENTIAL_TEXT_CASES, EMAIL_TEXT_CASES } from './scrub-cases'
import { assertNoFragments, assertViewAccepted, assertWithheld, cleanup, sendChunk, viewOf } from './view-support'

afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})

// Assembled at runtime so this file holds no credential-shaped literal.
const USER = ['zq8', 'user'].join('')
const DOMAIN = ['corp', 'mail.com'].join('-')
const LITERAL = `${USER}@${DOMAIN}`
const ENCODED = `${USER}\\u0040${DOMAIN}`
const KEY = ['sk', 'ant', 'abcdefghijklmnopqrstuvwx'].join('-')
const FRAGMENTS = [USER, 'corp-mail', 'u0040']

const MARKER_LENGTH = '[… truncated]'.length

type Kind = 'stimulus' | 'input' | 'output'
const LIMIT: Record<Kind, number> = { stimulus: RENDER_LIMITS.stimulus, input: RENDER_LIMITS.input, output: RENDER_LIMITS.output }
/** The text before a tool input's `content`, in its serialization. */
const INPUT_PREFIX = '{"content":"'.length

/** Words of two letters, so no run is long enough for a rule and no word is a key name; exactly `length` characters, ending in a space. */
const filler = (length: number): string => (length <= 0 ? '' : `${'ab cd '.repeat(Math.ceil(length / 6)).slice(0, length - 1)} `)

/** The view of a call with `text` as the stimulus, the tool input's content or the tool output. */
function viewOfKind(kind: Kind, text: string) {
  if (kind === 'stimulus') return viewOf({ user: text })
  if (kind === 'input') return viewOf({ input: { content: text } })
  return viewOf({ output: text })
}

/** `text` placed so that `piece` starts at `start` of what the view cuts: the stimulus text, the serialized input or the output. */
function placed(kind: Kind, piece: string, start: number): string {
  const at = kind === 'input' ? start - INPUT_PREFIX : start
  return `${filler(at)}${piece} ${filler(LIMIT[kind] * 2)}`
}

const allText = (rendered: ReturnType<typeof viewOf>['rendered']): string => JSON.stringify(rendered.scopes)

describe('no fragment of an address survives the cut', () => {
  const FORMS: [string, string][] = [
    ['an address written with an escape', ENCODED],
    ['an address written out and the same one written with an escape', `${LITERAL} ${ENCODED}`],
    ['an address written out', LITERAL],
  ]

  for (const kind of ['stimulus', 'input', 'output'] as const) {
    for (const [name, piece] of FORMS) {
      test(`${kind}: ${name}, with the cut falling before, inside and after it`, async () => {
        const cut = LIMIT[kind] - MARKER_LENGTH
        // where the encoded copy starts in the serialization of an input, whose backslashes are doubled
        const length = (kind === 'input' ? JSON.stringify(piece).length - 2 : piece.length) + 1
        for (const start of [cut - length - 2, cut - length, cut - length + 1, cut - Math.floor(length / 2), cut - 3, cut - 1, cut, cut + 1, cut + 40]) {
          const { f, rendered } = viewOfKind(kind, placed(kind, piece, start))
          const shown = allText(rendered)
          for (const fragment of FRAGMENTS) expect([kind, name, start, fragment, shown.includes(fragment)]).toEqual([kind, name, start, fragment, false])
          for (const scope of rendered.scopes) for (const stimulus of scope.stimuli) for (const text of [stimulus.text, ...stimulus.traffic]) expect([start, holdsSecret(text)]).toEqual([start, false])
          const scope = rendered.scopes[0]
          if (!scope) throw new Error('no scope')
          const { transport, run } = await sendChunk(f, chunkScope(scope, { budget: 100_000 }))
          expect([kind, name, start, run.coverageComplete]).toEqual([kind, name, start, true])
          const sent = transport.requests.map((r) => `${r.system}\n${r.user}`).join('\n')
          for (const fragment of FRAGMENTS) expect([kind, name, start, fragment, sent.includes(fragment)]).toEqual([kind, name, start, fragment, false])
        }
      }, 120_000)
    }
  }

  test('an address that is only written with an escape withholds the whole text, wherever the cut is; a literal one is replaced and the text kept', () => {
    const encoded = viewOfKind('output', placed('output', ENCODED, 100))
    expect(allText(encoded.rendered)).toContain(SCRUB_PLACEHOLDER)
    expect(encoded.rendered.counters).toMatchObject({ scrubbedOutputs: 1, redactedEmails: 0 })
    const literal = viewOfKind('output', placed('output', LITERAL, 100))
    expect(allText(literal.rendered)).toContain('[email]')
    expect(literal.rendered.counters).toMatchObject({ scrubbedOutputs: 0, redactedEmails: 1 })
  })
})

describe('a cut can make a fragment the guard refuses: the text is then withheld', () => {
  // An address on a reserved domain is not an email finding, but the front of it, cut inside the domain, is: `…@docs.exam` reads as an
  // address on an ordinary one. The view must not keep such a fragment, and the withholding is the render of the text, not a later pass.
  const RESERVED = ['writer', 'docs.example.com'].join('@')

  test('the guard accepts what the view keeps wherever the cut falls in the address, and the text is withheld by its own render', () => {
    const cut = LIMIT.output - MARKER_LENGTH
    let withheld = 0
    let kept = 0
    for (let start = cut - RESERVED.length - 2; start <= cut + 2; start++) {
      const { rendered } = viewOfKind('output', placed('output', RESERVED, start))
      const [line] = rendered.scopes[0]?.stimuli[0]?.traffic ?? []
      expect([start, holdsSecret(line ?? '')]).toEqual([start, false])
      expect([start, rendered.counters.scrubbedStimuli]).toEqual([start, 0])
      if (rendered.counters.scrubbedOutputs === 1) withheld += 1
      else kept += 1
    }
    // a cut inside the domain is withheld; one before the address or after it keeps the text
    expect(withheld).toBeGreaterThan(0)
    expect(kept).toBeGreaterThan(0)
  })

  test('an address on a reserved domain that the cut does not touch is kept whole', () => {
    const { rendered } = viewOfKind('output', `see ${RESERVED} for details`)
    expect(allText(rendered)).toContain(RESERVED)
    expect(rendered.counters.scrubbedOutputs).toBe(0)
  })
})

describe('a text is withheld rather than cut inside an escape', () => {
  const ESCAPE = '\\u00e9'

  test('an escape that names nothing secret, with the cut inside it or touching a backslash, is withheld; a cut just before or after it keeps the text', () => {
    const cut = LIMIT.output - MARKER_LENGTH
    const withheld = (start: number, piece = ESCAPE): boolean => viewOfKind('output', placed('output', piece, start)).rendered.counters.scrubbedOutputs === 1
    for (const start of [cut - 5, cut - 4, cut - 3, cut - 2, cut - 1]) expect([start, withheld(start)]).toEqual([start, true])
    for (const start of [cut - 6, cut, cut + 1]) expect([start, withheld(start)]).toEqual([start, false])
    // a run of backslashes that the cut falls in or touches
    for (const start of [cut - 3, cut - 1]) expect([start, withheld(start, '\\\\\\\\\\\\')]).toEqual([start, true])
    // a doubled escape, as it is written in a serialized string
    expect(withheld(cut - 3, '\\\\u00e9')).toBe(true)
  })

  test('a cut never leaves half of a surrogate pair', () => {
    const cut = LIMIT.output - MARKER_LENGTH
    for (const start of [cut - 2, cut - 1, cut]) {
      const { rendered } = viewOfKind('output', placed('output', '\u{1f600}\u{1f600}\u{1f600}', start))
      const [line] = rendered.scopes[0]?.stimuli[0]?.traffic ?? []
      expect([start, line?.isWellFormed()]).toEqual([start, true])
    }
  })

  test('the text the cut leaves is what was scanned: the kept view ends with the marker and is the length of the limit', () => {
    const { rendered } = viewOfKind('output', placed('output', 'plain words here', 100))
    const [line] = rendered.scopes[0]?.stimuli[0]?.traffic ?? []
    expect(line?.endsWith('[… truncated]')).toBe(true)
  })
})

describe('the scan covers the whole text, kept or not', () => {
  /** Paragraphs of one short line each, so no line is near the line bound. */
  const paragraphs = (word: string, count: number): string => Array.from({ length: count }, () => `${word} and some words to keep the line going`).join('\n')

  test('a secret past the kept text withholds the text, wherever it lies, in every kind', () => {
    for (const kind of ['stimulus', 'input', 'output'] as const) {
      for (const start of [LIMIT[kind] + 100, 9000, 15_000]) {
        const { rendered } = viewOfKind(kind, placed(kind, KEY, start))
        expect([kind, start, allText(rendered).includes(KEY), allText(rendered).includes(SCRUB_PLACEHOLDER)]).toEqual([kind, start, false, true])
      }
    }
  })

  test('a secret on a line far into a long multi-line text withholds it', () => {
    const text = `${paragraphs('first', 1500)}\n${KEY}\n${paragraphs('last', 100)}`
    expect(text.length).toBeGreaterThan(50_000)
    const { rendered } = viewOfKind('output', text)
    expect([allText(rendered).includes(KEY), allText(rendered).includes(SCRUB_PLACEHOLDER)]).toEqual([false, true])
  })

  test('a long text that shrinks a lot when paths are replaced is scanned whole, then kept and cut', () => {
    const text = Array.from({ length: 800 }, () => '/usr/local/lib/node_modules/some-package/dist/index.js').join('\n')
    const { rendered } = viewOfKind('output', text)
    expect(rendered.counters.scrubbedOutputs).toBe(0)
    expect(allText(rendered)).toContain('[… truncated]')
  })

  test('a long text of ordinary lines is kept and cut', () => {
    const { rendered } = viewOfKind('output', paragraphs('plain', 1500))
    expect(rendered.counters.scrubbedOutputs).toBe(0)
    expect(allText(rendered)).toContain('[… truncated]')
  })
})

describe('a very long line is withheld without being scanned', () => {
  const quickly = async (kind: Kind, length: number) => {
    const started = performance.now()
    const view = viewOfKind(kind, 'x'.repeat(length))
    const elapsed = performance.now() - started
    return { ...view, elapsed }
  }

  test('2,000,000 characters in one line, as a stimulus, an input and an output, in under two seconds', async () => {
    for (const kind of ['stimulus', 'input', 'output'] as const) {
      const { rendered, elapsed } = await quickly(kind, 2_000_000)
      expect([kind, elapsed < 2000]).toEqual([kind, true])
      expect([kind, allText(rendered).includes(SCRUB_PLACEHOLDER)]).toEqual([kind, true])
      expect(allText(rendered).length).toBeLessThan(2000)
    }
  }, 30_000)

  test('a line over the line bound is withheld at once, whole, whatever it holds: no part of it is kept', async () => {
    for (const kind of ['stimulus', 'output'] as const) {
      const { rendered, elapsed } = await quickly(kind, 100_000)
      expect([kind, elapsed < 2000]).toEqual([kind, true])
      expect([kind, allText(rendered).includes(SCRUB_PLACEHOLDER), allText(rendered).includes('[… truncated]')]).toEqual([kind, true, false])
    }
  }, 30_000)

  test('the pre-send guard refuses such a line at once, and a chunk of the view is not refused', async () => {
    const started = performance.now()
    expect(scrubFindings('x'.repeat(2_000_000)).has(SCRUB_LIMIT_RULE)).toBe(true)
    expect(holdsSecret('x'.repeat(100_000))).toBe(true)
    expect(performance.now() - started).toBeLessThan(2000)
    const { f, rendered } = viewOfKind('output', 'x'.repeat(100_000))
    const scope = rendered.scopes[0]
    if (!scope) throw new Error('no scope')
    const { run } = await sendChunk(f, chunkScope(scope, { budget: 100_000 }))
    expect(run.coverageComplete).toBe(true)
  }, 30_000)
})

describe('whatever crosses the cut, the view withholds it or holds none of it, and no request does', () => {
  const cut = LIMIT.output - MARKER_LENGTH
  const placedAtCut = (text: string): string => `${filler(cut - Math.min(text.length - 1, 12))}${text} ${filler(3000)}`

  test('every credential text of the shared table, placed so the cut falls inside it, is withheld and no 16-character run of it is anywhere', async () => {
    for (const text of CREDENTIAL_TEXT_CASES) await assertWithheld({ output: placedAtCut(text) }, [text], text.slice(0, 40))
  }, 300_000)

  test('every address text of the shared table, placed so the cut falls inside it, leaves no fragment of the address in the view or a request', async () => {
    const forms = [LITERAL, ENCODED]
    for (const text of EMAIL_TEXT_CASES) {
      await assertNoFragments({ output: placedAtCut(text) }, forms, text.slice(0, 40))
      await assertViewAccepted({ output: placedAtCut(text) }, text.slice(0, 40))
    }
  }, 300_000)

  test('the same, as a stimulus and as a tool input', async () => {
    for (const text of [...CREDENTIAL_TEXT_CASES.slice(0, 12), ...EMAIL_TEXT_CASES.slice(2, 5)]) {
      await assertNoFragments({ user: placedAtCut(text) }, [text, LITERAL, ENCODED], text.slice(0, 40))
      await assertNoFragments({ input: { content: placedAtCut(text) } }, [text, LITERAL, ENCODED], text.slice(0, 40))
    }
  }, 300_000)
})
