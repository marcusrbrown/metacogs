// Per-host rewrites of the shared skill text. The sources (`skills/**`, `plugin/skills/**`) stay byte-identical;
// a host's render is the source with an ordered table of exact-string rules applied. Each rule states how many
// times its source string must match in each skill it names, so an upstream wording edit fails generation, naming
// the rule, instead of passing through unrewritten.
//
// The renders are host-adapted text, not the text the evals measured. The match counts bound what changes.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The plugin and the MCP server are both named `metacogs`; `src/mcp/server.ts` registers the server under that name. */
export const PLUGIN_NAME = 'metacogs'
export const MCP_SERVER_NAME = 'metacogs'

/** Skills that describe a tool of the same name, then the two method skills. */
export const TOOL_SKILLS = ['feel', 'drugs'] as const
export const METHOD_SKILLS = ['synthesis', 'counterfactual'] as const
export const HOST_SKILLS = [...TOOL_SKILLS, ...METHOD_SKILLS] as const

export type ToolSkill = (typeof TOOL_SKILLS)[number]
export type SkillName = (typeof HOST_SKILLS)[number]

/** Repo-relative path of the shared source text. The tool skills belong to the OpenCode plugin, the method skills to the pack. */
export function skillSourcePath(skill: SkillName): string {
  return (TOOL_SKILLS as readonly string[]).includes(skill) ? `plugin/skills/${skill}/SKILL.md` : `skills/${skill}/SKILL.md`
}

export async function readSkillSource(root: string, skill: SkillName): Promise<string> {
  return readFile(join(root, ...skillSourcePath(skill).split('/')), 'utf8')
}

export interface Rule {
  /** Names the rule in the error when its count is off. */
  name: string
  /** Skills the rule applies to. Each must match `count` times. */
  skills: readonly SkillName[]
  /** Exact source text. Matched literally, never as a pattern. */
  from: string
  to: string
  /** Non-overlapping matches expected in each named skill's source. */
  count: number
}

/** What differs between hosts: the tool names the model sees and the form a person types to start a skill. */
export interface HostProfile {
  readonly id: string
  /** Display name, used in the session-start note. */
  readonly label: string
  readonly toolName: (tool: ToolSkill) => string
  readonly invocation: (skill: SkillName) => string
}

/**
 * Claude Code names a plugin's MCP tools `mcp__plugin_<plugin>_<server>__<tool>`. Plugin skills are namespaced as
 * `/<plugin>:<skill>`. A bare `/feel` also works when no other command claims the name; the renders never say so,
 * because the denylist treats a bare slash form as an unrewritten leftover. The install docs carry that note.
 */
export const CLAUDE_PROFILE: HostProfile = {
  id: 'claude',
  label: 'Claude Code',
  toolName: tool => `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER_NAME}__${tool}`,
  invocation: skill => `/${PLUGIN_NAME}:${skill}`,
}

/** Typed after the command on each host's tool skill. */
const ARGUMENT_HINTS: Record<ToolSkill, string> = { feel: '[what is going on]', drugs: '[substance]' }

const OPENCODE_ARGUMENTS =
  "A slash command puts the user's arguments at the very end of this text, after the line about the base directory. If you loaded this skill yourself, there are none."
const TOOL_UNAVAILABLE = (tool: string): string => `If the \`${tool}\` tool is unavailable (for example because Node 22 is not installed), continue in plain text and say so.`

/** Both method skills tell the model where the helper lives. Claude Code fills in `${CLAUDE_SKILL_DIR}` in skill text. */
const RECORD_PATH_INTRO = "The path below is this skill's own directory, filled in by Claude Code; use it as written, never a guessed path."

export function claudeRules(profile: HostProfile = CLAUDE_PROFILE): Rule[] {
  const rules: Rule[] = []
  for (const skill of TOOL_SKILLS) {
    const tool = profile.toolName(skill)
    rules.push(
      {
        name: `${skill}: tool reference`,
        skills: [skill],
        from: `Call the \`${skill}\` tool (not the \`${skill}\` skill; you are reading the skill now)`,
        to: `Call the \`${tool}\` tool (not the \`${skill}\` skill; you are reading the skill now)`,
        count: 1,
      },
      {
        name: `${skill}: arguments`,
        skills: [skill],
        from: OPENCODE_ARGUMENTS,
        to: `The user starts this skill as \`${profile.invocation(skill)}\`. The arguments typed after the command, if any: $ARGUMENTS\n\nIf that is empty, or you loaded this skill yourself, there are none.`,
        count: 1,
      },
      {
        name: `${skill}: argument hint`,
        skills: [skill],
        from: 'Session length alone is not a reason.\n---\n',
        to: `Session length alone is not a reason.\nargument-hint: ${JSON.stringify(ARGUMENT_HINTS[skill])}\n---\n`,
        count: 1,
      },
      {
        name: `${skill}: tool-unavailable fallback`,
        skills: [skill],
        from: '## What it is and is not\n',
        to: `${TOOL_UNAVAILABLE(tool)}\n\n## What it is and is not\n`,
        count: 1,
      },
    )
  }
  rules.push({
    name: 'drugs: names the feel tool',
    skills: ['drugs'],
    from: 'the `feel` tool comes first.',
    to: `the \`${profile.toolName('feel')}\` tool comes first.`,
    count: 1,
  })
  rules.push(
    {
      name: 'record helper path',
      skills: METHOD_SKILLS,
      from: 'node "<skill-base-dir>/scripts/record.mjs"',
      to: 'node "${CLAUDE_SKILL_DIR}/scripts/record.mjs"',
      count: 1,
    },
    {
      name: 'synthesis: record helper intro',
      skills: ['synthesis'],
      from: 'Use the skill base directory the host reported, never a guessed path.',
      to: RECORD_PATH_INTRO,
      count: 1,
    },
    {
      name: 'counterfactual: record helper intro',
      skills: ['counterfactual'],
      from: "The host reports this skill's base directory when it loads the skill; use it, never a guessed path.",
      to: RECORD_PATH_INTRO,
      count: 1,
    },
  )
  return rules
}

function occurrences(text: string, needle: string): number {
  return needle === '' ? 0 : text.split(needle).length - 1
}

/**
 * The render of one skill: every rule that names the skill, in order, applied literally. Throws, naming the rule, when
 * a rule's match count is not the expected one. A rule is counted against the text it sees, after earlier rules ran.
 */
export function applyRules(rules: readonly Rule[], skill: SkillName, source: string): string {
  let text = source
  for (const rule of rules) {
    if (!rule.skills.includes(skill)) continue
    const found = occurrences(text, rule.from)
    if (found !== rule.count) {
      throw new Error(`rule "${rule.name}" matched ${found} time(s) in ${skillSourcePath(skill)}, expected ${rule.count}`)
    }
    text = text.split(rule.from).join(rule.to)
  }
  return text
}
