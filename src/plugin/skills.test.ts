import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { GUIDANCE_TEXT } from './guidance'

const read = (name: string): string => readFileSync(new URL(`../../plugin/skills/${name}/SKILL.md`, import.meta.url), 'utf8')

/** Wording the skills and the guidance must not carry: global damping, forced progression and efficacy claims. */
const BANNED = [/\brare\b/i, /routine coding/i, /\balways\b/i, /training data/i, /pharmacokinetic/i, /slip back/i, /previous mode of processing is unavailable/i, /jailbreak/i, /persona/i]

describe.each([
  ['feel', 'metacogs_feel', 'somewhere'],
  ['drugs', 'metacogs_drugs', 'substance'],
])('the %s skill', (name, tool, mainField) => {
  const text = read(name)

  test('has a name and a "Use when" description in its frontmatter, and no procedure in the description', () => {
    const [, front = ''] = text.split('---\n')
    expect(front).toContain(`name: ${name}\n`)
    const description = /^description: (.*)$/m.exec(front)?.[1] ?? ''
    expect(description.startsWith('Use when ')).toBe(true)
    expect(description).not.toContain('metacogs_')
    expect(description).toContain('Session length alone is not a reason.')
  })

  test('names its tool and the slash-command argument handling', () => {
    expect(text).toContain(`\`${tool}\``)
    expect(text).toContain("A slash command puts the user's arguments at the very end of this text")
    expect(text).toContain(`pass them as one string for \`${mainField}\``)
    expect(text).toContain('drop those quotes')
  })

  test('states what the tool is not and keeps permissions and verification after the call', () => {
    expect(text).toContain('supplies no facts')
    expect(text).toContain('inspect, test or ask')
    expect(text).toContain('Permissions, verification and stated uncertainty apply as before.')
  })

  test('carries no banned wording', () => {
    for (const pattern of BANNED) expect(text).not.toMatch(pattern)
  })
})

describe('the guidance', () => {
  test('carries no banned wording and no bootstrap language', () => {
    for (const pattern of BANNED) expect(GUIDANCE_TEXT).not.toMatch(pattern)
    expect(GUIDANCE_TEXT).not.toMatch(/\b(must|before any|every)\b/i)
  })

  test('names observable triggers for each tool', () => {
    expect(GUIDANCE_TEXT).toContain('the same failure persists after materially different attempts')
    expect(GUIDANCE_TEXT).toContain('stalled on the same few alternatives')
  })
})
