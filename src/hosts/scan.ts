// Checks over the generated host trees, run by `generate:check`: a denylist of OpenCode leftovers that no host
// render may contain, and a positive check that each host's own tokens are where they belong. The match counts in
// rules.ts bound what a rewrite changes; this scan catches what no rule covers.
import type { TreeMap } from '../generate/tree'
import { renderGuidance } from './guidance'
import {
  CLAUDE_INVOCATION_PREFIX,
  CLAUDE_PROFILE,
  CLAUDE_SKILL_DIR_VAR,
  CLAUDE_STYLE,
  CLAUDE_TOOL_PREFIX,
  CODEX_INVOCATION_PREFIX,
  CODEX_PROFILE,
  CODEX_SKILL_DIR_PLACEHOLDER,
  CODEX_STYLE,
  CODEX_TOOL_PREFIX,
  HOST_SKILLS,
  type HostProfile,
  METHOD_SKILLS,
  type RenderStyle,
  type SkillName,
  TOOL_SKILLS,
} from './rules'

export interface DenyEntry {
  name: string
  pattern: RegExp
  /** A string the pattern must match; the self-test uses it to prove each entry can fire. */
  example: string
}

/** Wording that belongs to the OpenCode form of a skill or of the guidance. */
export const DENYLIST: readonly DenyEntry[] = [
  { name: 'skill base directory placeholder', pattern: /<skill-base-dir>/, example: 'node "<skill-base-dir>/scripts/record.mjs"' },
  { name: 'base directory reported by the host', pattern: /base directory/i, example: 'Use the skill base directory the host reported' },
  { name: 'bare slash command', pattern: /(?<!\w)\/(?:feel|drugs)\b/, example: 'loaded with the tool or `/feel`' },
  { name: 'OpenCode skill tool', pattern: /the `skill` tool/, example: 'loaded with the `skill` tool' },
  {
    name: 'OpenCode argument wording',
    pattern: /A slash command puts the user's arguments|at the very end of this text/,
    example: "A slash command puts the user's arguments at the very end of this text",
  },
  { name: 'guidance block tag', pattern: /<\/?METACOGS_GUIDANCE>/, example: '<METACOGS_GUIDANCE>' },
  { name: 'tool called by its bare name', pattern: /Call the `(?:feel|drugs)` tool/, example: 'Call the `feel` tool (not the `feel` skill' },
]

export interface Finding {
  path: string
  problem: string
}

/** Denylist entries that match `text`, as findings against `path`. */
export function denylistFindings(path: string, text: string): Finding[] {
  return DENYLIST.filter(entry => entry.pattern.test(text)).map(entry => ({ path, problem: `denylisted: ${entry.name}` }))
}

/** What a host's render and note must contain. */
export interface HostExpectations {
  profile: HostProfile
  /** Repo-relative directory of the host package. */
  dir: string
  /** Tokens each skill render must contain. */
  skills: Record<SkillName, readonly string[]>
  /** Tokens that belong to another host. No render and no note may contain one. */
  forbidden: readonly string[]
}

/** The script path inside a style's `node "<path>"` record command. */
function recordScript(style: RenderStyle): string {
  const match = /^node "(.*)"$/.exec(style.recordCommand)
  if (match?.[1] === undefined) throw new Error(`scan: unexpected record command shape: ${style.recordCommand}`)
  return match[1]
}

export function claudeExpectations(profile: HostProfile = CLAUDE_PROFILE): HostExpectations {
  const skills = {} as Record<SkillName, readonly string[]>
  for (const skill of TOOL_SKILLS) skills[skill] = [profile.toolName(skill), '$ARGUMENTS', profile.invocation(skill)]
  for (const skill of METHOD_SKILLS) skills[skill] = [recordScript(CLAUDE_STYLE)]
  // What belongs to Codex: its tool and mention prefixes and its record placeholder.
  return { profile, dir: 'hosts/claude', skills, forbidden: [CODEX_TOOL_PREFIX, CODEX_INVOCATION_PREFIX, CODEX_SKILL_DIR_PLACEHOLDER] }
}

export function codexExpectations(profile: HostProfile = CODEX_PROFILE): HostExpectations {
  const skills = {} as Record<SkillName, readonly string[]>
  for (const skill of TOOL_SKILLS) skills[skill] = [profile.toolName(skill), profile.invocation(skill), 'follows the mention']
  for (const skill of METHOD_SKILLS) skills[skill] = [CODEX_STYLE.recordCommand]
  // What belongs to Claude: its tool and command prefixes and its skill-directory variable. `$ARGUMENTS` and the
  // `argument-hint` frontmatter line are Claude's too, but no profile or style constant holds them as a token.
  return {
    profile,
    dir: 'hosts/codex',
    skills,
    forbidden: ['$ARGUMENTS', 'argument-hint', CLAUDE_SKILL_DIR_VAR, CLAUDE_TOOL_PREFIX, CLAUDE_INVOCATION_PREFIX],
  }
}

/** Positive findings for one host's skills and note. A missing token means a rewrite did not land. */
export function positiveFindings(expect: HostExpectations, files: ReadonlyMap<SkillName, string>, note: string): Finding[] {
  const findings: Finding[] = []
  for (const skill of HOST_SKILLS) {
    const path = `${expect.dir}/skills/${skill}/SKILL.md`
    const text = files.get(skill)
    if (text === undefined) {
      findings.push({ path, problem: 'missing' })
      continue
    }
    for (const token of expect.skills[skill]) if (!text.includes(token)) findings.push({ path, problem: `missing token: ${token}` })
    for (const token of expect.forbidden) if (text.includes(token)) findings.push({ path, problem: `another host's token: ${token}` })
  }
  for (const tool of TOOL_SKILLS) {
    for (const token of [expect.profile.toolName(tool), expect.profile.invocation(tool)]) {
      if (!note.includes(token)) findings.push({ path: `${expect.dir} (session-start note)`, problem: `missing token: ${token}` })
    }
  }
  for (const token of expect.forbidden) {
    if (note.includes(token)) findings.push({ path: `${expect.dir} (session-start note)`, problem: `another host's token: ${token}` })
  }
  return findings
}

/** Denylist and positive findings for every host package present in `tree`. Hosts that are not in the tree are skipped. */
export function scanHostTrees(tree: TreeMap, hosts: readonly HostExpectations[] = [claudeExpectations(), codexExpectations()]): Finding[] {
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
  const findings: Finding[] = []
  for (const host of hosts) {
    if (!tree.has(`${host.dir}/skills/${HOST_SKILLS[0]}/SKILL.md`)) continue
    const files = new Map<SkillName, string>()
    for (const skill of HOST_SKILLS) {
      const path = `${host.dir}/skills/${skill}/SKILL.md`
      const entry = tree.get(path)
      if (entry === undefined) continue
      const text = decode(entry.bytes)
      files.set(skill, text)
      findings.push(...denylistFindings(path, text))
    }
    const note = renderGuidance(host.profile)
    findings.push(...denylistFindings(`${host.dir} (session-start note)`, note))
    findings.push(...positiveFindings(host, files, note))
  }
  return findings
}
