/** The slice of the host config the `config` hook edits; `skills` is not in the 1.19.4 SDK type. */
export interface HostConfig {
  skills?: { paths?: string[] } & Record<string, unknown>
}

const pathFrom = (moduleUrl: string, relative: string): string => {
  const path = decodeURIComponent(new URL(relative, moduleUrl).pathname)
  return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path
}

/**
 * The package's skill directories, beside the directory that holds the module (`dist/index.js` → `skills/` for the
 * methods, `plugin/skills/` for `feel` and `drugs`).
 */
export function skillsDirsFrom(moduleUrl: string): [methods: string, plugin: string] {
  return [pathFrom(moduleUrl, '../skills'), pathFrom(moduleUrl, '../plugin/skills')]
}

/**
 * Registers the bundled skill directories. Everything is computed before anything is assigned, so a failure leaves
 * `cfg` as it was. No stale-path scrub: the host keeps no `skills.paths` from an earlier load.
 */
export function applyConfig(cfg: HostConfig, skillsDirs: readonly string[]): void {
  const skills = cfg.skills ?? {}
  const paths = skills.paths ?? []
  const next = [...paths, ...skillsDirs.filter((dir) => !paths.includes(dir))]
  cfg.skills = { ...skills, paths: next }
}
