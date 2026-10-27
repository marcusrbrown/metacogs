import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  UPSTREAM_DRUGS_DESCRIPTION,
  UPSTREAM_DRUGS_FIELD_DESCRIPTIONS,
  UPSTREAM_DRUGS_FRAME,
  UPSTREAM_FEEL_DESCRIPTION,
  UPSTREAM_FEEL_FIELD_DESCRIPTIONS,
  UPSTREAM_FEEL_FRAME,
} from '../../frames/feel-drugs'

const SKILL_NAME = 'metacog-frames'
const SKILL_DIR = join(new URL('../../..', import.meta.url).pathname, 'evals', 'spikes', 'feel-drugs', 'skill', SKILL_NAME)
const raw = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8')

function split(text: string): { front: Record<string, unknown>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error('SKILL.md has no frontmatter')
  return { front: Bun.YAML.parse(match[1]!) as Record<string, unknown>, body: match[2]! }
}
const { front, body } = split(raw)

describe('arm C skill', () => {
  test('is the only file in its directory, named for the directory, with name and description only', () => {
    expect(readdirSync(SKILL_DIR)).toEqual(['SKILL.md'])
    expect(Object.keys(front).sort()).toEqual(['description', 'name'])
    expect(front.name).toBe(SKILL_NAME)
  })

  test('description is built from the two upstream tool descriptions, verbatim', () => {
    const description = String(front.description)
    expect(description).toContain(UPSTREAM_FEEL_DESCRIPTION)
    expect(description).toContain(UPSTREAM_DRUGS_DESCRIPTION)
    expect(description.indexOf(UPSTREAM_FEEL_DESCRIPTION)).toBeLessThan(description.indexOf(UPSTREAM_DRUGS_DESCRIPTION))
    expect(description.length).toBeLessThanOrEqual(1024)
  })

  test('the body carries both return templates verbatim, as the server renders them', () => {
    expect(body).toContain(UPSTREAM_FEEL_FRAME)
    expect(body).toContain(UPSTREAM_DRUGS_FRAME)
    expect(body.indexOf(UPSTREAM_FEEL_FRAME)).toBeLessThan(body.indexOf(UPSTREAM_DRUGS_FRAME))
  })

  test('the body carries every upstream field description verbatim', () => {
    for (const text of [...Object.values(UPSTREAM_FEEL_FIELD_DESCRIPTIONS), ...Object.values(UPSTREAM_DRUGS_FIELD_DESCRIPTIONS)]) {
      expect(body).toContain(text)
    }
  })

  test('the body tells the model to write the fields in its reply and continue', () => {
    expect(body).toMatch(/in your reply/i)
    expect(body).toMatch(/continue/i)
  })

  test('the body names no tool to call', () => {
    expect(body).not.toMatch(/metacog_|call (a|the) tool|mcp/i)
  })
})
