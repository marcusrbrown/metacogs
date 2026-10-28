import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT } from '../generate/tree'
import { buildSessionStartHook, NOTE_MAX_CHARS, renderGuidance } from './guidance'
import GUIDANCE_TEMPLATE from './guidance.md'
import { CLAUDE_PROFILE, CODEX_PROFILE, HOST_SKILLS, type HostProfile, TOOL_SKILLS } from './rules'

const note = renderGuidance(CLAUDE_PROFILE)

/** A host with different names, to prove the template takes every name from the profile. */
const OTHER: HostProfile = {
  id: 'other',
  label: 'Other Host',
  toolName: tool => `other_srv_${tool}`,
  recordTool: 'other_srv_record',
  invocation: skill => `$other:${skill}`,
}

const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+|\n+/).filter(s => s.trim() !== '')

describe('the session-start note', () => {
  test('is factual: no sentence addressed to the model uses call, use, must or similar', () => {
    for (const sentence of sentences(note)) expect(sentence, sentence).not.toMatch(/\b(call|calls|use|must|should|ensure|always|never|do not|don't|you|your)\b/i)
  })

  test('claims no authority and carries no markup of its own', () => {
    expect(note).not.toMatch(/\b(system|instruction|instructions|directive|mandatory|required|override)\b/i)
    expect(note).not.toMatch(/<[^>]+>/)
    expect(note).not.toContain('METACOGS_GUIDANCE')
  })

  test('names only tools and skills the package ships', () => {
    const tools = new Set(TOOL_SKILLS.map(tool => CLAUDE_PROFILE.toolName(tool)))
    const skills = new Set<string>(HOST_SKILLS)
    const invocations = new Set(HOST_SKILLS.map(skill => CLAUDE_PROFILE.invocation(skill)))
    const quoted = [...note.matchAll(/`([^`]+)`/g)].map(match => match[1] ?? '')
    expect(quoted.length).toBeGreaterThan(0)
    for (const name of quoted) expect(skills.has(name) || tools.has(name) || invocations.has(name), name).toBe(true)
    // every shipped tool, skill and invocation is named
    for (const name of [...tools, ...skills, ...invocations]) expect(quoted).toContain(name)
    // and nothing that looks like a tool or a command but is not shipped
    for (const mcp of note.match(/mcp__\w+/g) ?? []) expect(tools.has(mcp)).toBe(true)
    for (const command of note.match(/\/\w+:\w+/g) ?? []) expect(invocations.has(command)).toBe(true)
  })

  test('fits the Codex output cap, never starts like JSON and is plain text ending in a newline', () => {
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX_CHARS)
    expect(note).not.toMatch(/^\s*[{[]/)
    expect(note.endsWith('\n')).toBe(true)
  })

  test('says what each tool and skill is for and how a person starts it', () => {
    expect(note).toContain('metacogs is installed in Claude Code.')
    expect(note).toContain('The `feel` tool is `mcp__plugin_metacogs_metacogs__feel`.')
    expect(note).toContain('the same failure persists after materially different attempts')
    expect(note).toContain('stalled on the same few alternatives')
    expect(note).toContain('start that skill with `/metacogs:feel`')
    expect(note).toContain('start that skill with `/metacogs:drugs`')
    expect(note).toContain('`/metacogs:synthesis` and `/metacogs:counterfactual`')
    expect(note).toContain('Neither tool supplies facts or checks anything.')
  })

  test('is filled from the profile alone', () => {
    const other = renderGuidance(OTHER)
    expect(other).toContain('metacogs is installed in Other Host.')
    expect(other).toContain('`other_srv_feel`')
    expect(other).toContain('`$other:counterfactual`')
    expect(other).not.toContain('mcp__plugin')
    expect(other).not.toContain('{{')
  })

  test('a placeholder the profile does not define fails loudly', () => {
    expect(() => renderGuidance(CLAUDE_PROFILE, 'x {{nope}}')).toThrow('unknown placeholder {{nope}}')
  })

  test('refuses a note that is too long or that starts like JSON', () => {
    expect(() => renderGuidance(CLAUDE_PROFILE, 'x'.repeat(NOTE_MAX_CHARS + 1))).toThrow('the limit is 3000')
    expect(() => renderGuidance(CLAUDE_PROFILE, '{"a":1}')).toThrow('must not start with')
    expect(() => renderGuidance(CLAUDE_PROFILE, '[note]')).toThrow('must not start with')
  })

  test('the template carries no OpenCode wording and does not repeat the OpenCode text', () => {
    expect(GUIDANCE_TEMPLATE).not.toContain('If the `feel` tool is available')
    expect(GUIDANCE_TEMPLATE).not.toContain('`skill` tool')
  })

  test('plugin/guidance.md, the OpenCode text, is unchanged', () => {
    const text = readFileSync(join(REPO_ROOT, 'plugin', 'guidance.md'), 'utf8')
    expect(text.startsWith('# metacogs\n\nIf the `feel` tool is available, call it when a tension')).toBe(true)
  })
})

describe('the hook bundle', () => {
  test('is deterministic and embeds the note and the host', async () => {
    const options = { host: 'claude', note, version: '1.2.3' } as const
    const first = await buildSessionStartHook(options)
    expect(await buildSessionStartHook(options)).toBe(first)
    expect(first.startsWith('// generated — do not edit; run `bun run generate`\n// helper_version: 1.2.3\n')).toBe(true)
    expect(first).toContain(JSON.stringify(note))
    expect(first).not.toContain('__METACOGS_NOTE__')
    expect(first).not.toContain('__METACOGS_HOOK_HOST__')
  })

  test('imports only node:fs and node:path', async () => {
    const text = await buildSessionStartHook({ host: 'claude', note, version: '1.2.3' })
    const specifiers = [...text.matchAll(/\bimport\s*(?:[\w*${}\s,]+?\s*from\s*)?["']([^"']+)["']/g)].map(match => match[1])
    expect(specifiers.sort()).toEqual(['node:fs', 'node:path'])
    expect(text).not.toMatch(/\brequire\s*\(/)
  })
})
