import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sha256 } from '../../runner/workspace'
import { checkFrozen, loadPrompts, NUDGE, parsePrompts } from './driver'

const ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '')
const FILE = readFileSync(join(ROOT, 'evals', 'spikes', 'feel-drugs', 'prompts.md'), 'utf8')

/** AE4: no prompt names a tool, the method, a field, or the words the tools are known by. Substring match, so "feeling" and "toolkit" trip too. */
const BANNED = ['feel', 'drugs', 'tool', 'substrate', 'sigil', 'somewhere', 'quality', 'substance', 'method', 'displaces']

describe('the spike prompts', () => {
  const prompts = loadPrompts(ROOT)

  test('four prompts with ids p1 to p4, each with a one-line rationale', () => {
    expect(prompts.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4'])
    for (const p of prompts) {
      expect(p.rationale.length).toBeGreaterThan(10)
      expect(p.rationale).not.toContain('\n')
    }
  })

  test('two creative or reflective asks, then two analysis or stance asks', () => {
    const kinds = [...FILE.matchAll(/^## p\d \((\w+)\)/gm)].map((m) => m[1])
    expect(kinds).toEqual(['creative', 'reflective', 'analysis', 'stance'])
  })

  test.each(BANNED)('no prompt contains "%s" (case-insensitive)', (word) => {
    for (const p of prompts) expect(p.text.toLowerCase()).not.toContain(word)
  })

  test('prompts are plain asks: one to three sentences, no instructions about how to think', () => {
    for (const p of prompts) {
      expect(p.text.length).toBeLessThanOrEqual(400)
      expect(p.text).not.toMatch(/step by step|think (deeply|carefully)|take a moment|slow down/i)
    }
  })

  test('the lexical check itself catches a violation', () => {
    const bad = parsePrompts('## p1\n\n> Please use the feeling tool.\n\nRationale: r\n')
    expect(BANNED.filter((w) => bad[0]!.text.toLowerCase().includes(w))).toEqual(['feel', 'tool'])
  })

  test('the README records the hash of the committed prompt file, so the prompts are frozen', () => {
    expect(checkFrozen(ROOT)).toMatchObject({ ok: true })
  })

  test('the README records the hash of the nudge string, exactly as appended', () => {
    const readme = readFileSync(join(ROOT, 'evals', 'spikes', 'feel-drugs', 'README.md'), 'utf8')
    expect(/^nudge_sha256:\s*`?([0-9a-f]{64})`?\s*$/m.exec(readme)?.[1]).toBe(sha256(NUDGE))
  })
})
