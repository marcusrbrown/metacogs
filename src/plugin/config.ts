import type { Config } from '@opencode-ai/plugin'

import { mergeCommands } from './commands'
import type { Warn } from './options'

/** The slice of the host config the `config` hook edits; `skills` is not in the 1.19.4 SDK type. */
export type HostConfig = Pick<Config, 'command'> & { skills?: { paths?: string[] } & Record<string, unknown> }

/** The package's `skills/` directory, beside the directory that holds the module (`dist/index.js` → `skills/`). */
export function skillsDirFrom(moduleUrl: string): string {
  const path = decodeURIComponent(new URL('../skills', moduleUrl).pathname)
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path
}

/**
 * Registers the commands and the bundled skills path. Everything is computed before anything is assigned, so a failure
 * leaves `cfg` as it was. No stale-path scrub: the host keeps no `skills.paths` from an earlier load.
 */
export function applyConfig(cfg: HostConfig, skillsDir: string, warn: Warn): void {
  const command = mergeCommands(cfg.command, warn)
  const skills = cfg.skills ?? {}
  const paths = skills.paths ?? []
  const next = paths.includes(skillsDir) ? paths : [...paths, skillsDir]
  cfg.command = command
  cfg.skills = { ...skills, paths: next }
}
