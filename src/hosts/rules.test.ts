import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT } from '../generate/tree'
import { applyRules, CLAUDE_PROFILE, CODEX_PROFILE, claudeRules, codexRules, HOST_SKILLS, MCP_SERVER_NAME, PLUGIN_NAME, readSkillSource, type Rule, skillSourcePath } from './rules'

const sources = Object.fromEntries(await Promise.all(HOST_SKILLS.map(async skill => [skill, await readSkillSource(REPO_ROOT, skill)] as const))) as Record<(typeof HOST_SKILLS)[number], string>
const render = (skill: (typeof HOST_SKILLS)[number]): string => applyRules(claudeRules(), skill, sources[skill])
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1

describe('the Claude rule table', () => {
  test('every rule matches its expected count in every skill it names, against the real sources', () => {
    for (const rule of claudeRules()) {
      for (const skill of rule.skills) expect(occurrences(sources[skill], rule.from), `${rule.name} in ${skill}`).toBe(rule.count)
    }
  })

  test('rule names are unique and every skill has at least one rule', () => {
    const rules = claudeRules()
    expect(new Set(rules.map(rule => rule.name)).size).toBe(rules.length)
    for (const skill of HOST_SKILLS) expect(rules.some(rule => rule.skills.includes(skill)), skill).toBe(true)
  })

  test('the tool prefix is derived from the plugin and server names', () => {
    expect(CLAUDE_PROFILE.toolName('feel')).toBe(`mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER_NAME}__feel`)
    const renamed = { ...CLAUDE_PROFILE, toolName: (tool: string) => `mcp__plugin_other_srv__${tool}` }
    expect(applyRules(claudeRules(renamed), 'feel', sources.feel)).toContain('Call the `mcp__plugin_other_srv__feel` tool')
  })

  test('a changed source string fails generation, naming the rule', () => {
    const edited = sources.feel.replace('Call the `feel` tool (not the `feel` skill', 'Invoke the `feel` tool (not the `feel` skill')
    expect(() => applyRules(claudeRules(), 'feel', edited)).toThrow('rule "feel: tool reference" matched 0 time(s) in plugin/skills/feel/SKILL.md, expected 1')
    const reworded = sources.synthesis.replace('Use the skill base directory the host reported', 'Use the directory the host reported')
    expect(() => applyRules(claudeRules(), 'synthesis', reworded)).toThrow('rule "synthesis: record helper intro" matched 0 time(s)')
  })

  test('a source string that now appears twice fails too', () => {
    const doubled = `${sources.counterfactual}\n\`\`\`\nnode "<skill-base-dir>/scripts/record.mjs" <<'EOF'\n`
    expect(() => applyRules(claudeRules(), 'counterfactual', doubled)).toThrow('rule "record helper path" matched 2 time(s) in skills/counterfactual/SKILL.md, expected 1')
  })

  test('rules apply literally: a replacement holding $ patterns is inserted as written', () => {
    const rule: Rule = { name: 'literal', skills: ['feel'], from: 'Fields', to: '$& $1 $$ ${X}', count: 1 }
    expect(applyRules([rule], 'feel', 'Fields')).toBe('$& $1 $$ ${X}')
  })

  test('the shared sources are left alone: skill source paths and the OpenCode text are not rewritten in place', () => {
    for (const skill of HOST_SKILLS) {
      expect(readFileSync(join(REPO_ROOT, skillSourcePath(skill)), 'utf8')).toBe(sources[skill])
      expect(render(skill)).not.toBe(sources[skill])
    }
    expect(sources.feel).toContain('Call the `feel` tool (not the `feel` skill')
  })
})

describe('the Claude renders (AE1 and AE5, static parts)', () => {
  test('AE1: the drugs render maps the argument to substance and names the Claude tool', () => {
    const text = render('drugs')
    expect(text).toContain('Call the `mcp__plugin_metacogs_metacogs__drugs` tool (not the `drugs` skill; you are reading the skill now)')
    expect(text).toContain('The user starts this skill as `/metacogs:drugs`. The arguments typed after the command, if any: $ARGUMENTS')
    expect(text).toContain('If there are arguments, pass them as one string for `substance`.')
    expect(text).toContain('the `mcp__plugin_metacogs_metacogs__feel` tool comes first.')
  })

  test('the feel render maps the argument to somewhere and names its tool', () => {
    const text = render('feel')
    expect(text).toContain('Call the `mcp__plugin_metacogs_metacogs__feel` tool')
    expect(text).toContain('The arguments typed after the command, if any: $ARGUMENTS')
    expect(text).toContain('pass them as one string for `somewhere`.')
  })

  test('both tool renders carry the argument hint and the tool-unavailable fallback before the first section', () => {
    expect(render('feel')).toContain('Session length alone is not a reason.\nargument-hint: "[what is going on]"\n---\n')
    expect(render('drugs')).toContain('Session length alone is not a reason.\nargument-hint: "[substance]"\n---\n')
    for (const skill of ['feel', 'drugs'] as const) {
      const text = render(skill)
      const fallback = `If the \`mcp__plugin_metacogs_metacogs__${skill}\` tool is unavailable (for example because Node 22 is not installed), continue in plain text and say so.`
      expect(text).toContain(`${fallback}\n\n## What it is and is not\n`)
    }
  })

  test('AE5: the method renders run the record helper from the skill directory', () => {
    for (const skill of ['synthesis', 'counterfactual'] as const) {
      const text = render(skill)
      expect(text).toContain('node "${CLAUDE_SKILL_DIR}/scripts/record.mjs" <<\'EOF\'')
      expect(text).toContain("The path below is this skill's own directory, filled in by Claude Code; use it as written, never a guessed path.")
      expect(text).not.toContain('<skill-base-dir>')
    }
  })

  test('the method renders keep the rest of the evaluated text: only the helper lines differ', () => {
    for (const skill of ['synthesis', 'counterfactual'] as const) {
      const before = sources[skill].split('\n')
      const after = render(skill).split('\n')
      expect(after.length).toBe(before.length)
      const changed = before.flatMap((line, i) => (line === after[i] ? [] : [i + 1]))
      expect(changed.length).toBe(2)
    }
  })
})

const renderCodex = (skill: (typeof HOST_SKILLS)[number]): string => applyRules(codexRules(), skill, sources[skill])

describe('the Codex rule table', () => {
  test('every rule matches its expected count in every skill it names, against the real sources', () => {
    for (const rule of codexRules()) {
      for (const skill of rule.skills) expect(occurrences(sources[skill], rule.from), `${rule.name} in ${skill}`).toBe(rule.count)
    }
  })

  test('has the Claude rules minus the argument hint: same sources, same counts, Codex replacements', () => {
    const claude = claudeRules()
    const codex = codexRules()
    expect(codex.map(rule => rule.name)).toEqual(claude.map(rule => rule.name).filter(name => !name.endsWith(': argument hint')))
    for (const rule of codex) {
      const twin = claude.find(other => other.name === rule.name)
      expect(twin, rule.name).toBeDefined()
      expect({ from: rule.from, count: rule.count, skills: rule.skills }, rule.name).toEqual({ from: twin!.from, count: twin!.count, skills: twin!.skills })
    }
    expect(new Set(codex.map(rule => rule.name)).size).toBe(codex.length)
  })

  test('the tool names are derived from the server name; skills are namespaced by the plugin name', () => {
    expect(CODEX_PROFILE.toolName('feel')).toBe(`mcp__${MCP_SERVER_NAME}__feel`)
    expect(CODEX_PROFILE.toolName('drugs')).toBe('mcp__metacogs__drugs')
    expect(CODEX_PROFILE.invocation('feel')).toBe(`$${PLUGIN_NAME}:feel`)
    const renamed = { ...CODEX_PROFILE, toolName: (tool: string) => `mcp__other__${tool}` }
    expect(applyRules(codexRules(renamed), 'feel', sources.feel)).toContain('Call the `mcp__other__feel` tool')
  })

  test('a changed source string fails generation, naming the rule', () => {
    const edited = sources.drugs.replace('the `feel` tool comes first.', 'the `feel` tool goes first.')
    expect(() => applyRules(codexRules(), 'drugs', edited)).toThrow('rule "drugs: names the feel tool" matched 0 time(s) in plugin/skills/drugs/SKILL.md, expected 1')
    const reworded = sources.counterfactual.replace("The host reports this skill's base directory", 'The host reports the directory')
    expect(() => applyRules(codexRules(), 'counterfactual', reworded)).toThrow('rule "counterfactual: record helper intro" matched 0 time(s)')
  })
})

describe('the Codex renders', () => {
  test('both tool renders name the Codex tool and the $ mention, and carry no Claude mechanics', () => {
    for (const skill of ['feel', 'drugs'] as const) {
      const text = renderCodex(skill)
      expect(text).toContain(`Call the \`mcp__metacogs__${skill}\` tool (not the \`${skill}\` skill; you are reading the skill now)`)
      expect(text).toContain(`The user starts this skill by writing \`$metacogs:${skill}\`.`)
      expect(text).not.toContain('$ARGUMENTS')
      expect(text).not.toContain('argument-hint')
      expect(text).not.toContain('mcp__plugin_')
      expect(text).toContain('Session length alone is not a reason.\n---\n')
    }
    expect(renderCodex('drugs')).toContain('the `mcp__metacogs__feel` tool comes first.')
  })

  test('AE2: with no text after the mention the model picks the fields from the session', () => {
    const text = renderCodex('feel')
    expect(text).toContain("The arguments, if any, are the plain text that follows the mention in the user's message; read them from there.")
    expect(text).toContain(
      'If no text follows the mention, or you loaded this skill yourself, there are none.\n\nIf there are arguments, pass them as one string for `somewhere`.',
    )
    expect(text).toContain('If there are none, choose `somewhere`, `quality` and `sigil` yourself from what is going on in this session.')
    expect(renderCodex('drugs')).toContain('If there are none, choose `substance`, `method` and `displaces` yourself from what is going on in this session.')
  })

  test('both tool renders carry the tool-unavailable fallback before the first section', () => {
    for (const skill of ['feel', 'drugs'] as const) {
      const fallback = `If the \`mcp__metacogs__${skill}\` tool is unavailable (for example because Node 22 is not installed), continue in plain text and say so.`
      expect(renderCodex(skill)).toContain(`${fallback}\n\n## What it is and is not\n`)
    }
  })

  test('the method renders run the helper from the directory of the SKILL.md path Codex gave, quoted', () => {
    for (const skill of ['synthesis', 'counterfactual'] as const) {
      const text = renderCodex(skill)
      expect(text).toContain('node "<directory of this SKILL.md>/scripts/record.mjs" <<\'EOF\'')
      expect(text).toContain('Codex gave you the path of this SKILL.md when it loaded the skill.')
      expect(text).toContain('keep the quotes around the whole path, and never use a guessed path.')
      expect(text).not.toContain('<skill-base-dir>')
      expect(text).not.toMatch(/base directory/i)
      expect(text).not.toContain('CLAUDE_SKILL_DIR')
    }
  })

  test('AE6: a denied or failed write is reported as unrecorded, as in the source', () => {
    expect(renderCodex('synthesis')).toContain(
      'Exit 3 or 4, a refused command, or no Node: do not rerun. Say no record was written; `execution_mode` is `unrecorded`.',
    )
    expect(renderCodex('counterfactual')).toContain(
      'Exit 3 or 4, a refused command, or no Node: rerun nothing. Reply, say no record was written, and state `execution_mode` as `unrecorded`.',
    )
  })

  test('AE7 (static): no skill depends on the session-start hook', () => {
    for (const skill of HOST_SKILLS) {
      expect(renderCodex(skill), skill).not.toMatch(/session[- ]start|hooks?\b|\/hooks|guidance/i)
    }
  })

  test('the method renders keep the rest of the evaluated text: only the helper lines differ', () => {
    for (const skill of ['synthesis', 'counterfactual'] as const) {
      const before = sources[skill].split('\n')
      const after = renderCodex(skill).split('\n')
      expect(after.length).toBe(before.length)
      expect(before.flatMap((line, i) => (line === after[i] ? [] : [i + 1])).length).toBe(2)
    }
  })

  test('the shared sources are left alone', () => {
    for (const skill of HOST_SKILLS) {
      expect(readFileSync(join(REPO_ROOT, skillSourcePath(skill)), 'utf8')).toBe(sources[skill])
      expect(renderCodex(skill)).not.toBe(sources[skill])
    }
  })
})
