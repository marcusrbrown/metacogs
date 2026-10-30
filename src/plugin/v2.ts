import type { Plugin, Skill } from '@opencode/plugin'
import { object, toJSONSchema } from 'zod'

import COUNTERFACTUAL_MD from '../../skills/counterfactual/SKILL.md'
import SYNTHESIS_MD from '../../skills/synthesis/SKILL.md'
import DRUGS_MD from '../../plugin/skills/drugs/SKILL.md'
import FEEL_MD from '../../plugin/skills/feel/SKILL.md'
import { DRUGS_DESCRIPTION, drugsText, FEEL_DESCRIPTION, feelText } from '../frames/feel-drugs'
import { GUIDANCE_BLOCK, GUIDANCE_OPEN } from './guidance'
import { parseOptions } from './options'
import { DRUGS_ARGS, FEEL_ARGS } from './v1'

// OpenCode v2 adapter. `@opencode/plugin` is imported for types only, so the built plugin loads with neither host
// package installed.
//
// A throwing transform disables the whole plugin on the host, and the host replays transforms long after `setup` has
// returned. So every transform body and every hook callback runs through `guarded`, which logs one line without any
// argument value and carries on. A failure in one registration costs only that registration.

/** The skills the plugin ships, in registration order. `plugin` skills sit under `plugin/skills/`, the rest under `skills/`. */
const SKILL_SOURCES = [
  { text: FEEL_MD, home: 'plugin' },
  { text: DRUGS_MD, home: 'plugin' },
  { text: SYNTHESIS_MD, home: 'methods' },
  { text: COUNTERFACTUAL_MD, home: 'methods' },
] as const

interface EmbeddedSkill {
  name: string
  description: string
  /** The `SKILL.md` body with the frontmatter removed. */
  content: string
  /** Where the `SKILL.md` lives, so the host resolves `scripts/record.mjs` from its directory. */
  path: string
}

/** Splits `---` frontmatter off a skill file. Both fields are single-line scalars in every shipped skill. */
function parseSkill(text: string, directory: string): EmbeddedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) throw new Error('a skill has no frontmatter')
  const field = (key: string): string => new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(match[1] ?? '')?.[1]?.trim() ?? ''
  const name = field('name')
  if (name === '') throw new Error('a skill has no name')
  return { name, description: field('description'), content: (match[2] ?? '').trim(), path: `${directory}/${name}/SKILL.md` }
}

/** The four skills for given directories: `[skills/, plugin/skills/]`, as `skillsDirsFrom` returns them. */
function embeddedSkills([methods, plugin]: readonly [string, string]): EmbeddedSkill[] {
  return SKILL_SOURCES.map(({ text, home }) => parseSkill(text, home === 'plugin' ? plugin : methods))
}

/** A tool's JSON Schema from the same zod fields v1 uses, without the `$schema` key. */
function inputSchema(args: Parameters<typeof object>[0]) {
  const { $schema: _dropped, ...schema } = toJSONSchema(object(args))
  return schema
}

/** One diagnostic line on stderr, the only channel a v2 plugin has. It names the part and never carries a value. */
const report = (part: string): void => console.error(`metacogs: ${part} failed`)

/** Runs `body`; a throw is reported and the call returns normally. Transforms and hooks return nothing to restore. */
function guarded<Args extends unknown[]>(part: string, body: (...args: Args) => void): (...args: Args) => void {
  return (...args) => {
    try {
      body(...args)
    } catch {
      report(part)
    }
  }
}

/** Awaits one registration; a rejection is reported and the next registration still runs. */
async function register(part: string, registration: () => Promise<unknown>): Promise<void> {
  try {
    await registration()
  } catch {
    report(`${part} registration`)
  }
}

/** The v2 `setup` for given skill directories. The entry passes the two beside the built module. */
export function createSetup(skillsDirs: readonly [string, string]): (ctx: unknown) => Promise<void> {
  return async (rawCtx) => {
    const probe = rawCtx as { location?: unknown; session?: unknown } | null | undefined
    if (!probe?.location || !probe?.session) return
    const ctx = rawCtx as Plugin.Context

    let skills: EmbeddedSkill[] = []
    try {
      skills = embeddedSkills(skillsDirs)
    } catch {
      report('skills')
    }

    await register('tool', () =>
      ctx.tool.transform(
        guarded('tool transform', (editor) => {
          // The host rejects a missing required field before `execute` runs and strips extra ones, so the input has the schema's shape.
          guarded('tool feel', () =>
            editor.add({ name: 'feel', description: FEEL_DESCRIPTION, input: inputSchema(FEEL_ARGS), options: { codemode: false }, execute: async (input) => ({ content: feelText(input as unknown as Parameters<typeof feelText>[0]) }) }),
          )()
          guarded('tool drugs', () =>
            editor.add({ name: 'drugs', description: DRUGS_DESCRIPTION, input: inputSchema(DRUGS_ARGS), options: { codemode: false }, execute: async (input) => ({ content: drugsText(input as unknown as Parameters<typeof drugsText>[0]) }) }),
          )()
        }),
      ),
    )

    await register('skill', () =>
      ctx.skill.transform(
        guarded('skill transform', (editor) => {
          for (const skill of skills) {
            const { name, description, content, path } = skill
            guarded(`skill ${name}`, () => editor.add({ id: name as Skill.ID, name: name as Skill.Name, description, path: path as Skill.Info['path'], content }))()
          }
        }),
      ),
    )

    // A user's own command with the same name wins on the host. None of the four names is a v2 built-in (`init`,
    // `review`, `goal`, ...). There is no deny gate: a denied skill typed as a command is delivered, as on v1.
    await register('command', () =>
      ctx.command.transform(
        guarded('command transform', (editor) => {
          for (const { name, description } of skills) {
            guarded(`command ${name}`, () =>
              editor.add({
                name,
                description,
                // Errors from here stay visible to whoever ran the command, so nothing is caught.
                execute: async ({ sessionID, prompt, delivery }) => {
                  const attached = prompt.skills ?? []
                  const id = name as Skill.ID
                  await ctx.session.prompt({
                    sessionID,
                    text: prompt.text,
                    files: prompt.files,
                    agents: prompt.agents,
                    skills: attached.some((skill) => skill.id === id) ? attached : [...attached, { id }],
                    delivery,
                  })
                },
              }),
            )()
          }
        }),
      ),
    )

    // Guidance rides on the `context` hook, which fires for agent-loop requests only: never title, compaction or
    // generate. Nothing is persisted, so the option takes effect when the plugin next initializes.
    const settings = parseOptions(ctx.options, (_key, message) => console.error(`metacogs: ${message}`))
    if (settings.guidance) {
      await register('guidance', () =>
        ctx.session.hook(
          'context',
          guarded('guidance', (request) => {
            if (request.system.some((part) => part.text.includes(GUIDANCE_OPEN))) return
            request.system.push({ type: 'text', text: GUIDANCE_BLOCK })
          }),
        ),
      )
    }
  }
}
