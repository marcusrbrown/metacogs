import DRUGS_MD from '../../plugin/commands/drugs.md'
import FEEL_MD from '../../plugin/commands/feel.md'
import type { Warn } from './options'

/** Marks the command entries this plugin owns, so they refresh on every load and a user's own entry is never overwritten. */
export const COMMAND_PREFIX = '(metacogs) '

export interface CommandEntry {
  template: string
  description: string
}

export const COMMANDS = {
  feel: { template: FEEL_MD, description: `${COMMAND_PREFIX}Attend to what is here before it has words` },
  drugs: { template: DRUGS_MD, description: `${COMMAND_PREFIX}Shift how you process with a named substrate` },
} as const satisfies Record<string, CommandEntry>

type CommandMap = Record<string, { template: string; description?: string }>

const isOwn = (entry: { description?: string }): boolean => entry.description?.startsWith(COMMAND_PREFIX) === true

/**
 * `existing` without any prefixed entry, plus this plugin's commands. A key that already exists without the prefix is
 * the user's: it is kept and logged once. The input is not changed.
 */
export function mergeCommands(existing: CommandMap | undefined, warn: Warn): CommandMap {
  const merged: CommandMap = Object.fromEntries(Object.entries(existing ?? {}).filter(([, entry]) => !isOwn(entry)))
  for (const [name, entry] of Object.entries(COMMANDS)) {
    if (name in merged) warn(`command.${name}`, `a command named ${name} already exists; metacogs leaves it alone`)
    else merged[name] = entry
  }
  return merged
}
