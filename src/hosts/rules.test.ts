import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { REPO_ROOT } from '../generate/tree'
import { applyRules, CLAUDE_PROFILE, CLAUDE_TOOL_PREFIX, CODEX_PROFILE, CODEX_TOOL_PREFIX, claudeRules, codexRules, HOST_SKILLS, MCP_SERVER_NAME, METHOD_SKILLS, PLUGIN_NAME, RECORD_TOOL, readSkillSource, type Rule, skillSourcePath } from './rules'

const sources = Object.fromEntries(await Promise.all(HOST_SKILLS.map(async skill => [skill, await readSkillSource(REPO_ROOT, skill)] as const))) as Record<(typeof HOST_SKILLS)[number], string>
const render = (skill: (typeof HOST_SKILLS)[number]): string => applyRules(claudeRules(), skill, sources[skill])
const renderCodex = (skill: (typeof HOST_SKILLS)[number]): string => applyRules(codexRules(), skill, sources[skill])
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1
/** Anything that tells the model to run a script or a shell command, or that still names the helper. */
const HELPER_OR_SHELL = /record\.mjs|<skill-base-dir>|<<'EOF'|\bEOF\b|stdin|\bbash\b|\bshell\b|\bhelper\b|\bnode "|base directory|CLAUDE_SKILL_DIR|directory of this SKILL\.md|Exit [0-9]/i

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
    expect(() => applyRules(claudeRules(), 'synthesis', reworded)).toThrow('rule "synthesis: record call intro" matched 0 time(s)')
    const outcomes = sources.counterfactual.replace('- Exit 0: written. Reply.', '- Exit 0: written.')
    expect(() => applyRules(claudeRules(), 'counterfactual', outcomes)).toThrow('rule "counterfactual: outcomes" matched 0 time(s)')
  })

  test('a source string that now appears twice fails too', () => {
    const doubled = `${sources.counterfactual}\n\`\`\`\nnode "<skill-base-dir>/scripts/record.mjs" <<'EOF'\n`
    expect(() => applyRules(claudeRules(), 'counterfactual', doubled)).toThrow('rule "record: command line" matched 2 time(s) in skills/counterfactual/SKILL.md, expected 1')
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

  test('AE5: the method renders call the record tool and carry no helper or shell instruction', () => {
    for (const skill of METHOD_SKILLS) {
      const text = render(skill)
      expect(text).toContain(`\`${CLAUDE_PROFILE.recordTool}\``)
      expect(text).toContain('Its arguments are the fields of this JSON:')
      expect(text).not.toMatch(HELPER_OR_SHELL)
    }
  })

  test('the record tool name is derived from the prefix constants', () => {
    expect(CLAUDE_PROFILE.recordTool).toBe(`${CLAUDE_TOOL_PREFIX}${PLUGIN_NAME}_${MCP_SERVER_NAME}__${RECORD_TOOL}`)
    expect(CLAUDE_PROFILE.recordTool).toBe('mcp__plugin_metacogs_metacogs__record')
    expect(CODEX_PROFILE.recordTool).toBe(`${CODEX_TOOL_PREFIX}${RECORD_TOOL}`)
    expect(CODEX_PROFILE.recordTool).toBe('mcp__metacogs__record')
  })
})

describe('the method renders keep the evaluated text', () => {
  for (const [host, apply] of [['Claude', render], ['Codex', renderCodex]] as const) {
    test(`${host}: reasoning steps 2 to 7, the Reply section and the frontmatter apart from compatibility are byte-identical to the canonical text, and step 1 differs only by "no helper"`, () => {
      for (const skill of METHOD_SKILLS) {
        const section = (text: string, from: string, to?: string): string => {
          const start = text.indexOf(from)
          const end = to === undefined ? text.length : text.indexOf(to)
          return text.slice(start, end)
        }
        const canonical = sources[skill]
        const rendered = apply(skill)
        // Everything from the title through step 7 (counterfactual's step 8 is the record step, which is adapted).
        // The one allowed difference: step 1's gate loses "no helper".
        const stepsEnd = skill === 'counterfactual' ? '8. **Record' : '## Record'
        const gate = 'no announcement, no helper, no record'
        expect(occurrences(section(canonical, '# ', stepsEnd), gate), skill).toBe(1)
        expect(section(rendered, '# ', stepsEnd), skill).toBe(section(canonical, '# ', stepsEnd).replace(gate, 'no announcement, no record'))
        expect(section(rendered, '## Reply'), skill).toBe(section(canonical, '## Reply'))
        const front = (text: string): string[] => text.split('---\n')[1]!.split('\n').filter(line => !line.startsWith('compatibility:'))
        expect(front(rendered), skill).toEqual(front(canonical))
      }
    })

    test(`${host}: step 8 names the tool and keeps the completeness test`, () => {
      const step8 = apply('counterfactual').split('\n').find(line => line.startsWith('8. **Record'))!
      const tool = (apply === render ? CLAUDE_PROFILE : CODEX_PROFILE).recordTool
      expect(step8).toBe(
        `8. **Record, before any reply text.** Call the \`${tool}\` tool (below) now, once. Once the gate has passed this step is not optional and the reply comes after it: an answer with no \`${tool}\` call, and no "unrecorded" note after a failed one, is incomplete.`,
      )
    })

    test(`${host}: no helper or shell instruction remains in a method render`, () => {
      for (const skill of METHOD_SKILLS) expect(apply(skill), skill).not.toMatch(HELPER_OR_SHELL)
    })

    test(`${host}: the outcome lines say written, fix once, and unrecorded for everything else`, () => {
      const outcomes = (skill: (typeof METHOD_SKILLS)[number]): string[] => apply(skill).split('\n').filter(line => /^- (A successful result|An error naming|Any other error)/.test(line))
      expect(outcomes('synthesis')).toEqual([
        '- A successful result with a `path`: written.',
        '- An error naming a field: fix it and call again once.',
        '- Any other error, a refused call, or no such tool: do not call again; say the run is `unrecorded`.',
      ])
      expect(outcomes('counterfactual')).toEqual([
        '- A successful result with a `path`: written. Reply.',
        '- An error naming a field: fix it and call again once.',
        '- Any other error, a refused call, or no such tool: do not call again. Reply and say the run is `unrecorded`.',
      ])
    })

    test(`${host}: the compatibility line names the tool and says the server needs Node 22 or later`, () => {
      const tool = (apply === render ? CLAUDE_PROFILE : CODEX_PROFILE).recordTool
      for (const skill of METHOD_SKILLS) {
        expect(apply(skill)).toContain(`compatibility: The \`${tool}\` tool is served by the metacogs MCP server, which needs Node 22 or later. Without it the method still runs and the run is marked unrecorded.\n`)
      }
    })

    test(`${host}: the JSON template survives without the node line and the terminator, and the fence holds only the JSON`, () => {
      for (const skill of METHOD_SKILLS) {
        const fence = apply(skill).match(/```\n([\s\S]*?)\n```/)![1]!
        expect(JSON.parse(fence).method, skill).toBe(skill)
        expect(fence.split('\n')).toHaveLength(1)
      }
    })
  }
})

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

  test('every record rule keeps an exact match count of one against the unchanged canonical text', () => {
    for (const rules of [claudeRules(), codexRules()]) {
      const record = rules.filter(rule => rule.name.startsWith('record:') || /^(synthesis|counterfactual): (record|outcomes)/.test(rule.name))
      expect(record.length).toBe(10)
      for (const rule of record) {
        expect(rule.count, rule.name).toBe(1)
        for (const skill of rule.skills) expect(occurrences(sources[skill], rule.from), `${rule.name} in ${skill}`).toBe(1)
      }
    }
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
    expect(() => applyRules(codexRules(), 'counterfactual', reworded)).toThrow('rule "counterfactual: record call intro" matched 0 time(s)')
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

  test('the method renders call the Codex record tool and name no Claude mechanics', () => {
    for (const skill of METHOD_SKILLS) {
      const text = renderCodex(skill)
      expect(text).toContain(`\`${CODEX_PROFILE.recordTool}\``)
      expect(text).not.toContain('mcp__plugin_')
      expect(text).not.toContain('CLAUDE_SKILL_DIR')
      expect(text).not.toMatch(/base directory/i)
    }
  })

  test('AE6: a denied or failed write is reported as unrecorded', () => {
    expect(renderCodex('synthesis')).toContain('- Any other error, a refused call, or no such tool: do not call again; say the run is `unrecorded`.')
    expect(renderCodex('counterfactual')).toContain('- Any other error, a refused call, or no such tool: do not call again. Reply and say the run is `unrecorded`.')
  })

  test('AE7 (static): no skill depends on the session-start hook', () => {
    for (const skill of HOST_SKILLS) {
      expect(renderCodex(skill), skill).not.toMatch(/session[- ]start|hooks?\b|\/hooks|guidance/i)
    }
  })

  test('the shared sources are left alone', () => {
    for (const skill of HOST_SKILLS) {
      expect(readFileSync(join(REPO_ROOT, skillSourcePath(skill)), 'utf8')).toBe(sources[skill])
      expect(renderCodex(skill)).not.toBe(sources[skill])
    }
  })
})
