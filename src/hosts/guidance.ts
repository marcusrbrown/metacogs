// The session-start note and the hook that prints it. The note is one factual template (src/hosts/guidance.md)
// filled with a host's names; the hook bundle embeds the filled text, so a host runs one dependency-free script.
import { join } from 'node:path'
import { helperBanner } from '../generate/marker'
import { REPO_ROOT } from '../plugin/build'
import GUIDANCE_TEMPLATE from './guidance.md'
import { HOST_SKILLS, type HostProfile, TOOL_SKILLS } from './rules'

/** Codex prints at most about 2,500 tokens of hook output; the note stays well inside it. */
export const NOTE_MAX_CHARS = 3000

export type HookHost = 'claude'

export const SESSION_START_ENTRY = join(REPO_ROOT, 'src', 'hosts', 'session-start.ts')

/** The names the template may use, so a typo in either place fails here instead of printing `{{...}}`. */
function placeholders(profile: HostProfile): Record<string, string> {
  const fill: Record<string, string> = { host: profile.label }
  for (const tool of TOOL_SKILLS) fill[`${tool}_tool`] = profile.toolName(tool)
  for (const skill of HOST_SKILLS) fill[`${skill}_invoke`] = profile.invocation(skill)
  return fill
}

/** The note for one host. Plain text that never starts with `{` or `[` (Codex parses output that looks like JSON). */
export function renderGuidance(profile: HostProfile, template: string = GUIDANCE_TEMPLATE): string {
  const fill = placeholders(profile)
  const text = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = fill[key]
    if (value === undefined) throw new Error(`guidance template: unknown placeholder {{${key}}}`)
    return value
  })
  if (text.length > NOTE_MAX_CHARS) throw new Error(`guidance note is ${text.length} characters; the limit is ${NOTE_MAX_CHARS}`)
  if (/^\s*[{[]/.test(text)) throw new Error('guidance note must not start with { or [')
  return text
}

/** Bundle the hook for one host with the filled note embedded. Deterministic for fixed inputs. */
export async function buildSessionStartHook(options: { host: HookHost; note: string; version: string }): Promise<string> {
  const result = await Bun.build({
    entrypoints: [SESSION_START_ENTRY],
    root: REPO_ROOT,
    target: 'node',
    format: 'esm',
    minify: false,
    sourcemap: 'none',
    splitting: false,
    banner: helperBanner(options.version),
    define: {
      __METACOGS_HOOK_HOST__: JSON.stringify(options.host),
      __METACOGS_NOTE__: JSON.stringify(options.note),
    },
  })
  if (!result.success) throw new Error(`session-start hook bundle failed:\n${result.logs.map(log => log.message).join('\n')}`)
  const [output] = result.outputs
  if (result.outputs.length !== 1 || output === undefined) throw new Error('session-start hook bundle produced an unexpected output set')
  return output.text()
}
