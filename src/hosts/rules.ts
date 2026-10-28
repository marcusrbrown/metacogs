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
 * The text each host puts in front of a tool name or a skill name. The profiles build their output from these, and the
 * rewrite scan (scan.ts) reads them back as the other host's forbidden tokens, so the two cannot drift apart.
 */
export const CLAUDE_TOOL_PREFIX = 'mcp__plugin_'
export const CODEX_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`
export const CLAUDE_INVOCATION_PREFIX = `/${PLUGIN_NAME}:`
export const CODEX_INVOCATION_PREFIX = `$${PLUGIN_NAME}:`

/** How each host's record command names the skill's own directory: a variable Claude fills in, a placeholder the model fills in on Codex. */
export const CLAUDE_SKILL_DIR_VAR = 'CLAUDE_SKILL_DIR'
export const CODEX_SKILL_DIR_PLACEHOLDER = '<directory of this SKILL.md>'

/**
 * Claude Code names a plugin's MCP tools `mcp__plugin_<plugin>_<server>__<tool>`. Plugin skills are namespaced as
 * `/<plugin>:<skill>`. A bare `/feel` also works when no other command claims the name; the renders never say so,
 * because the denylist treats a bare slash form as an unrewritten leftover. The install docs carry that note.
 */
export const CLAUDE_PROFILE: HostProfile = {
  id: 'claude',
  label: 'Claude Code',
  toolName: tool => `${CLAUDE_TOOL_PREFIX}${PLUGIN_NAME}_${MCP_SERVER_NAME}__${tool}`,
  invocation: skill => `${CLAUDE_INVOCATION_PREFIX}${skill}`,
}

/**
 * Codex names an MCP tool `mcp__<server>__<tool>` after the server key in `mcp.json`, and namespaces a plugin's skills
 * as `<plugin>:<skill>`, started with a `$` mention.
 */
export const CODEX_PROFILE: HostProfile = {
  id: 'codex',
  label: 'Codex',
  toolName: tool => `${CODEX_TOOL_PREFIX}${tool}`,
  invocation: skill => `${CODEX_INVOCATION_PREFIX}${skill}`,
}

/** Typed after the command on each host's tool skill. */
const ARGUMENT_HINTS: Record<ToolSkill, string> = { feel: '[what is going on]', drugs: '[substance]' }

const OPENCODE_ARGUMENTS =
  "A slash command puts the user's arguments at the very end of this text, after the line about the base directory. If you loaded this skill yourself, there are none."
const TOOL_UNAVAILABLE = (tool: string): string => `If the \`${tool}\` tool is unavailable (for example because Node 22 is not installed), continue in plain text and say so.`

/** What differs between hosts beyond names: how arguments reach the model and how the record helper is found. */
export interface RenderStyle {
  /** Replaces the OpenCode argument paragraph; takes the skill's invocation. */
  argumentsText: (invocation: string) => string
  /** Whether the tool skills get an `argument-hint` frontmatter line (Claude shows it; Codex does not honour it). */
  argumentHint: boolean
  /** Replaces `node "<skill-base-dir>/scripts/record.mjs"` in both method skills. */
  recordCommand: string
  /** Replaces the sentence that tells the model where the helper lives. */
  recordIntro: string
}

/** Claude Code fills in `$ARGUMENTS` and `${CLAUDE_SKILL_DIR}` in skill text. */
export const CLAUDE_STYLE: RenderStyle = {
  argumentsText: invocation =>
    `The user starts this skill as \`${invocation}\`. The arguments typed after the command, if any: $ARGUMENTS\n\nIf that is empty, or you loaded this skill yourself, there are none.`,
  argumentHint: true,
  recordCommand: `node "\${${CLAUDE_SKILL_DIR_VAR}}/scripts/record.mjs"`,
  recordIntro: "The path below is this skill's own directory, filled in by Claude Code; use it as written, never a guessed path.",
}

/**
 * Codex substitutes nothing in skill text. Text after the `$` mention is plain text in the user's message, and the model
 * is handed the path of each SKILL.md it loads, so the helper directory is that path's directory.
 */
export const CODEX_STYLE: RenderStyle = {
  argumentsText: invocation =>
    `The user starts this skill by writing \`${invocation}\`. Codex does not fill in arguments. The arguments, if any, are the plain text that follows the mention in the user's message; read them from there.\n\nIf no text follows the mention, or you loaded this skill yourself, there are none.`,
  argumentHint: false,
  recordCommand: `node "${CODEX_SKILL_DIR_PLACEHOLDER}/scripts/record.mjs"`,
  recordIntro: `Codex gave you the path of this SKILL.md when it loaded the skill. Replace \`${CODEX_SKILL_DIR_PLACEHOLDER}\` below with the directory that path is in, keep the quotes around the whole path, and never use a guessed path.`,
}

function hostRules(profile: HostProfile, style: RenderStyle): Rule[] {
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
        to: style.argumentsText(profile.invocation(skill)),
        count: 1,
      },
    )
    if (style.argumentHint) {
      rules.push({
        name: `${skill}: argument hint`,
        skills: [skill],
        from: 'Session length alone is not a reason.\n---\n',
        to: `Session length alone is not a reason.\nargument-hint: ${JSON.stringify(ARGUMENT_HINTS[skill])}\n---\n`,
        count: 1,
      })
    }
    rules.push({
      name: `${skill}: tool-unavailable fallback`,
      skills: [skill],
      from: '## What it is and is not\n',
      to: `${TOOL_UNAVAILABLE(tool)}\n\n## What it is and is not\n`,
      count: 1,
    })
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
      to: style.recordCommand,
      count: 1,
    },
    {
      name: 'synthesis: record helper intro',
      skills: ['synthesis'],
      from: 'Use the skill base directory the host reported, never a guessed path.',
      to: style.recordIntro,
      count: 1,
    },
    {
      name: 'counterfactual: record helper intro',
      skills: ['counterfactual'],
      from: "The host reports this skill's base directory when it loads the skill; use it, never a guessed path.",
      to: style.recordIntro,
      count: 1,
    },
  )
  return rules
}

export function claudeRules(profile: HostProfile = CLAUDE_PROFILE): Rule[] {
  return hostRules(profile, CLAUDE_STYLE)
}

export function codexRules(profile: HostProfile = CODEX_PROFILE): Rule[] {
  return hostRules(profile, CODEX_STYLE)
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
