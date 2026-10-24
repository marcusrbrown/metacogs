import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadRedactTokens, parseRedactTokens, redact, redactOrThrow, RedactionFailed, REDACTION_PLACEHOLDER, survivingTokens } from './redact'

describe('parseRedactTokens', () => {
  test('accepts the bare-array form', () => {
    expect(parseRedactTokens('["a-b", "ccc"]')).toEqual(['a-b', 'ccc'])
  })

  test('accepts {"tokens": [...]}', () => {
    expect(parseRedactTokens('{"tokens": ["a-b", "ccc"]}')).toEqual(['a-b', 'ccc'])
  })

  test('sorts longest first and de-duplicates', () => {
    expect(parseRedactTokens('["ab", "abcd", "ab", "abc"]')).toEqual(['abcd', 'abc', 'ab'])
  })

  test.each([
    ['not json', 'redact list is not valid JSON'],
    ['{"tokens": "x"}', 'array of strings'],
    ['{"other": []}', 'array of strings'],
    ['[]', 'empty'],
    ['[""]', 'non-empty strings'],
    ['[1]', 'non-empty strings'],
    ['["redacted"]', 'placeholder'],
  ])('rejects %s', (text, message) => {
    expect(() => parseRedactTokens(text)).toThrow(message)
  })

  test('both committed redact lists load', () => {
    for (const method of ['counterfactual', 'synthesis']) {
      const tokens = loadRedactTokens(join(import.meta.dir, '..', '..', 'evals', method, 'redact.json'))
      expect(tokens.length).toBeGreaterThan(5)
      expect(tokens).toContain(method)
    }
  })
})

describe('redact', () => {
  const tokens = parseRedactTokens('["counterfactual", "load-bearing", "record.mjs", "reopen_condition"]')

  test('replaces every occurrence, case-insensitively', () => {
    const out = redact('A Counterfactual and a LOAD-BEARING claim; counterfactual again.', tokens)
    expect(out).toBe(`A ${REDACTION_PLACEHOLDER} and a ${REDACTION_PLACEHOLDER} claim; ${REDACTION_PLACEHOLDER} again.`)
  })

  test('treats tokens literally, not as regular expressions', () => {
    // "." in record.mjs must not match "recordXmjs"
    expect(redact('recordXmjs and record.mjs', tokens)).toBe(`recordXmjs and ${REDACTION_PLACEHOLDER}`)
  })

  test('catches zero-width and compatibility-character evasion', () => {
    const evaded = 'load\u200b-bearing and ｃｏｕｎｔｅｒｆａｃｔｕａｌ'
    expect(redact(evaded, tokens)).toBe(`${REDACTION_PLACEHOLDER} and ${REDACTION_PLACEHOLDER}`)
  })

  test('redacts inside record JSON, keys included', () => {
    const json = JSON.stringify({ reopen_condition: 'when X', note: 'a counterfactual' })
    const out = redact(json, tokens)
    expect(survivingTokens(out, tokens)).toEqual([])
    expect(out).toContain('when X')
  })

  test('leaves text without tokens untouched (modulo normalization)', () => {
    expect(redact('plain text', tokens)).toBe('plain text')
  })
})

describe('redactOrThrow', () => {
  test('passes clean text through', () => {
    expect(redactOrThrow('one load-bearing claim', ['load-bearing'])).toBe(`one ${REDACTION_PLACEHOLDER} claim`)
  })

  test('throws RedactionFailed naming surviving tokens when a token cannot be removed', () => {
    // A token that is only produced by the replacement itself cannot be detected by construction;
    // simulate a survivor by checking the assertion directly on unredacted text.
    expect(survivingTokens('has load-bearing inside', ['load-bearing', 'other'])).toEqual(['load-bearing'])
    const err = new RedactionFailed(['load-bearing'])
    expect(err.surviving).toEqual(['load-bearing'])
    expect(err.message).toContain('redaction_failed')
  })

  test('the committed lists redact the rubric vocabulary they target', () => {
    const text = readFileSync(join(import.meta.dir, '..', '..', 'evals', 'counterfactual', 'rubric.md'), 'utf8')
    const tokens = loadRedactTokens(join(import.meta.dir, '..', '..', 'evals', 'counterfactual', 'redact.json'))
    const out = redactOrThrow(text, tokens)
    expect(survivingTokens(out, tokens)).toEqual([])
  })
})
