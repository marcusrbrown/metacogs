import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT } from '../generate/tree'
import { GUIDANCE_BLOCK } from '../plugin/guidance'
import { applyRules, CODEX_PROFILE, codexRules, HOST_SKILLS, readSkillSource, skillSourcePath } from './rules'
import { claudeExpectations, codexExpectations, DENYLIST, denylistFindings, positiveFindings, scanHostTrees } from './scan'

describe('the denylist', () => {
  test('every entry fires on its own example', () => {
    for (const entry of DENYLIST) expect(entry.pattern.test(entry.example), entry.name).toBe(true)
  })

  test('self-test: the unrewritten sources fail it', async () => {
    for (const skill of HOST_SKILLS) {
      const findings = denylistFindings(skillSourcePath(skill), await readSkillSource(REPO_ROOT, skill))
      expect(findings.length, `${skillSourcePath(skill)} should trip the denylist`).toBeGreaterThan(0)
    }
    // The OpenCode guidance and the block it is wrapped in.
    expect(denylistFindings('plugin/guidance.md', readFileSync(join(REPO_ROOT, 'plugin', 'guidance.md'), 'utf8')).map(f => f.problem)).toEqual([
      'denylisted: bare slash command',
      'denylisted: OpenCode skill tool',
    ])
    expect(denylistFindings('block', GUIDANCE_BLOCK).map(f => f.problem)).toContain('denylisted: guidance block tag')
  })

  test('each of the two tool skills and the two method skills trips the entries that apply to it', async () => {
    const problems = async (skill: (typeof HOST_SKILLS)[number]) => denylistFindings(skill, await readSkillSource(REPO_ROOT, skill)).map(f => f.problem)
    for (const skill of ['feel', 'drugs'] as const) {
      expect(await problems(skill)).toEqual(['denylisted: base directory reported by the host', 'denylisted: OpenCode argument wording', 'denylisted: tool called by its bare name'])
    }
    expect(await problems('synthesis')).toEqual(['denylisted: skill base directory placeholder', 'denylisted: base directory reported by the host'])
    expect(await problems('counterfactual')).toEqual(['denylisted: skill base directory placeholder', 'denylisted: base directory reported by the host'])
  })

  test('does not fire on host forms: a namespaced command, a path, a Claude tool name', () => {
    const fine = [
      'Start it with `/metacogs:feel`.',
      'See hosts/claude/skills/feel/SKILL.md and skills/drugs/SKILL.md.',
      'Call the `mcp__plugin_metacogs_metacogs__feel` tool (not the `feel` skill; you are reading the skill now)',
    ].join('\n')
    expect(denylistFindings('x', fine)).toEqual([])
  })

  test('does not fire on Codex forms: a $ mention, a Codex tool name, a placeholder for the SKILL.md directory', () => {
    const fine = [
      'Start it with `$metacogs:feel`.',
      'Call the `mcp__metacogs__feel` tool (not the `feel` skill; you are reading the skill now)',
      'node "<directory of this SKILL.md>/scripts/record.mjs" <<\'EOF\'',
    ].join('\n')
    expect(denylistFindings('x', fine)).toEqual([])
  })

  test('self-test: the Codex renders pass it and the unrewritten sources do not', async () => {
    for (const skill of HOST_SKILLS) {
      const source = await readSkillSource(REPO_ROOT, skill)
      expect(denylistFindings(`codex ${skill}`, applyRules(codexRules(), skill, source)), skill).toEqual([])
      expect(denylistFindings(skillSourcePath(skill), source).length, skill).toBeGreaterThan(0)
    }
  })

  test('fires on a bare /feel or /drugs, at the start of a line and after punctuation', () => {
    for (const bad of ['/feel', 'type /drugs now', '(`/feel`)']) expect(denylistFindings('x', bad).length, bad).toBeGreaterThan(0)
  })
})

describe('the positive check', () => {
  test('a render that lost a token fails, naming the file and the token', () => {
    const files = new Map(HOST_SKILLS.map(skill => [skill, 'no tokens'] as const))
    const findings = positiveFindings(claudeExpectations(), files, 'no tokens here')
    expect(findings).toContainEqual({ path: 'hosts/claude/skills/drugs/SKILL.md', problem: 'missing token: mcp__plugin_metacogs_metacogs__drugs' })
    expect(findings).toContainEqual({ path: 'hosts/claude/skills/synthesis/SKILL.md', problem: 'missing token: ${CLAUDE_SKILL_DIR}/scripts/record.mjs' })
    expect(findings).toContainEqual({ path: 'hosts/claude (session-start note)', problem: 'missing token: /metacogs:feel' })
  })

  test('a skill with no render at all is reported as missing', () => {
    expect(positiveFindings(claudeExpectations(), new Map(), '')).toContainEqual({ path: 'hosts/claude/skills/feel/SKILL.md', problem: 'missing' })
  })

  test('a Codex render that lost a token fails, naming the file and the token', () => {
    const files = new Map(HOST_SKILLS.map(skill => [skill, 'no tokens'] as const))
    const findings = positiveFindings(codexExpectations(), files, 'no tokens here')
    expect(findings).toContainEqual({ path: 'hosts/codex/skills/drugs/SKILL.md', problem: 'missing token: mcp__metacogs__drugs' })
    expect(findings).toContainEqual({ path: 'hosts/codex/skills/feel/SKILL.md', problem: 'missing token: $metacogs:feel' })
    expect(findings).toContainEqual({ path: 'hosts/codex/skills/feel/SKILL.md', problem: 'missing token: follows the mention' })
    expect(findings).toContainEqual({ path: 'hosts/codex/skills/counterfactual/SKILL.md', problem: 'missing token: node "<directory of this SKILL.md>/scripts/record.mjs"' })
    // Codex ships no session-start note, so there is nothing to check in one.
    expect(findings.filter(f => f.path.includes('session-start note'))).toEqual([])
  })

  test("a token that belongs to the other host is reported in a render, and in the Claude note", () => {
    const files = new Map(HOST_SKILLS.map(skill => [skill, 'x /metacogs:feel x'] as const))
    expect(positiveFindings(codexExpectations(), files, '')).toEqual(
      expect.arrayContaining([{ path: 'hosts/codex/skills/feel/SKILL.md', problem: "another host's token: /metacogs:" }]),
    )
    expect(positiveFindings(claudeExpectations(), new Map(), 'x mcp__metacogs__feel x')).toContainEqual({
      path: 'hosts/claude (session-start note)',
      problem: "another host's token: mcp__metacogs__",
    })
    const claudeFiles = new Map(HOST_SKILLS.map(skill => [skill, 'x $metacogs:feel x'] as const))
    expect(positiveFindings(claudeExpectations(), claudeFiles, 'x').map(f => f.problem)).toContain("another host's token: $metacogs:")
  })

  test('Claude\'s "as a bash call" wording in a Codex render is reported', () => {
    const files = new Map(HOST_SKILLS.map(skill => [skill, 'Run the helper now, once, as a bash call.'] as const))
    expect(positiveFindings(codexExpectations(), files, 'x')).toContainEqual({
      path: 'hosts/codex/skills/counterfactual/SKILL.md',
      problem: "another host's token: as a bash call",
    })
    expect(positiveFindings(claudeExpectations(), files, 'x').map(f => f.problem)).not.toContain("another host's token: as a bash call")
  })

  test('the Codex expectations name the tools and mentions from the profile, and expect no note', () => {
    const expectations = codexExpectations()
    expect(expectations.dir).toBe('hosts/codex')
    expect(expectations.note).toBe(false)
    expect(claudeExpectations().note).toBe(true)
    expect(expectations.skills.feel).toEqual([CODEX_PROFILE.toolName('feel'), '$metacogs:feel', 'follows the mention'])
    expect(expectations.skills.synthesis).toEqual(['node "<directory of this SKILL.md>/scripts/record.mjs"'])
  })

  test('hosts that are not in the tree are skipped', () => {
    expect(scanHostTrees(new Map())).toEqual([])
  })
})
