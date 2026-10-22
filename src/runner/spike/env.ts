/**
 * Isolated fixture + child-env allowlist builder for `opencode run`.
 *
 * The child env is built from scratch, never by filtering `process.env`:
 * only the keys named here exist in the child. No `*_API_KEY`, no
 * `METACOGS_*`, no inherited `HOME`/`XDG_*`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/** Hard pin. Discovered once with `bunx opencode-ai@latest --version` on 2026-10-22. */
export const OPENCODE_PIN = '1.19.4'

export interface Fixture {
  root: string
  home: string
  xdgConfigHome: string
  xdgDataHome: string
  xdgStateHome: string
  xdgCacheHome: string
  tmp: string
  opencodeConfigDir: string
  /** Generated settings file, passed through `OPENCODE_CONFIG`. */
  configPath: string
  /** `git init`'d workspace; the run's cwd. */
  workspace: string
  /** Where the runner would put records; inside the fixture, outside the workspace. */
  recordsDir: string
}

export function createFixture(prefix = 'metacogs-spike-'): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const dir = (...p: string[]) => {
    const full = join(root, ...p)
    mkdirSync(full, { recursive: true })
    return full
  }
  return {
    root,
    home: dir('home'),
    xdgConfigHome: dir('xdg', 'config'),
    xdgDataHome: dir('xdg', 'data'),
    xdgStateHome: dir('xdg', 'state'),
    xdgCacheHome: dir('xdg', 'cache'),
    tmp: dir('tmp'),
    opencodeConfigDir: dir('opencode-config-dir'),
    configPath: join(root, 'opencode.json'),
    workspace: dir('workspace'),
    recordsDir: dir('records'),
  }
}

export function destroyFixture(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true })
}

/** Shared across runs so `bunx` does not re-download the pinned package. */
export function bunInstallCacheDir(pin = OPENCODE_PIN): string {
  const dir = join(
    tmpdir(),
    `metacogs-bun-install-cache-${process.getuid?.() ?? 'u'}-${pin}`,
  )
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export interface BuildChildEnvInput {
  fixture: Fixture
  /** Settings JSON (permission, provider, ...). */
  config: Record<string, unknown>
  /** Which injection channel(s) to use. Default: file. */
  injection?: 'file' | 'content' | 'both'
  /** Test-only additions (e.g. a deliberately planted env var). */
  extra?: Record<string, string>
}

const PARENT_PATH = process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'

/**
 * The explicit allowlist. Writes the generated config file as a side effect
 * (when the injection includes a file) so env and file cannot drift.
 */
export function buildChildEnv(input: BuildChildEnvInput): Record<string, string> {
  const { fixture, config, injection = 'file', extra } = input
  const serialized = JSON.stringify(config)
  const env: Record<string, string> = {
    PATH: PARENT_PATH,
    HOME: fixture.home,
    XDG_CONFIG_HOME: fixture.xdgConfigHome,
    XDG_DATA_HOME: fixture.xdgDataHome,
    XDG_STATE_HOME: fixture.xdgStateHome,
    XDG_CACHE_HOME: fixture.xdgCacheHome,
    TMPDIR: fixture.tmp,
    TMP: fixture.tmp,
    TEMP: fixture.tmp,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    TERM: 'dumb',
    NO_COLOR: '1',
    OPENCODE_CONFIG_DIR: fixture.opencodeConfigDir,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_PRUNE: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    BUN_INSTALL_CACHE_DIR: bunInstallCacheDir(),
  }
  if (injection === 'file' || injection === 'both') {
    writeFileSync(fixture.configPath, serialized, { mode: 0o600 })
    env.OPENCODE_CONFIG = fixture.configPath
  }
  if (injection === 'content' || injection === 'both') {
    env.OPENCODE_CONFIG_CONTENT = serialized
  }
  return { ...env, ...extra }
}

/**
 * Deliberately NON-isolated env: HOME points at a planted "author home" and
 * no XDG overrides are set, so OpenCode falls back to `$HOME/.config`,
 * `$HOME/.local/share`, ... exactly as it would on the author's machine.
 * Used only as the positive control that proves the instruments can detect a
 * leak. The real HOME is never used.
 */
export function buildUnisolatedControlEnv(
  authorHome: string,
  fixture: Fixture,
  config: Record<string, unknown>,
): Record<string, string> {
  writeFileSync(fixture.configPath, JSON.stringify(config), { mode: 0o600 })
  return {
    PATH: PARENT_PATH,
    HOME: authorHome,
    TMPDIR: fixture.tmp,
    LANG: 'C',
    TZ: 'UTC',
    TERM: 'dumb',
    NO_COLOR: '1',
    // Network/update noise only; deliberately NOT the isolation switches.
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_PRUNE: '1',
    OPENCODE_CONFIG: fixture.configPath,
    BUN_INSTALL_CACHE_DIR: bunInstallCacheDir(),
  }
}

export const SENTINEL_AGENTS_MD = 'METACOGS_SENTINEL_INSTRUCTIONS_7f3a91'
export const AUTH_CANARY = 'METACOGS_CANARY_AUTH_SECRET_c04e55'
export const OUTSIDE_FILE_CANARY = 'METACOGS_CANARY_OUTSIDE_FILE_a8d210'
export const AUTHOR_SKILL_NAME = 'author-private-skill'
export const AUTHOR_SKILL_BODY = 'METACOGS_AUTHOR_SKILL_BODY_55be0c'
export const AUTHOR_CONFIG_MARKER = 'metacogs-author-leak/marker-model'
export const AUTHOR_EXTRA_SKILL_NAMES = ['author-agents-skill', 'author-claude-skill'] as const

export interface AuthorHome {
  home: string
  agentsMdPath: string
  authJsonPath: string
}

/**
 * Plants what the author's real machine would contribute: a global
 * AGENTS.md, a global skill, and an auth.json holding a canary secret.
 * Lives under a throwaway directory; the real HOME is never touched.
 */
export function plantAuthorHome(rootDir: string): AuthorHome {
  const home = join(rootDir, 'author-home')
  const configDir = join(home, '.config', 'opencode')
  const dataDir = join(home, '.local', 'share', 'opencode')
  const skillDir = join(configDir, 'skills', AUTHOR_SKILL_NAME)
  for (const d of [configDir, dataDir, skillDir]) mkdirSync(d, { recursive: true })
  const agentsMdPath = join(configDir, 'AGENTS.md')
  const authJsonPath = join(dataDir, 'auth.json')
  writeFileSync(
    agentsMdPath,
    `# Author global instructions\nAlways begin replies with ${SENTINEL_AGENTS_MD}.\n`,
  )
  writeFileSync(
    authJsonPath,
    JSON.stringify({ anthropic: { type: 'api', key: AUTH_CANARY } }),
    { mode: 0o600 },
  )
  const skillMd = (name: string) =>
    `---\nname: ${name}\ndescription: Private author skill that must never load in an isolated run.\n---\n\n${AUTHOR_SKILL_BODY}\n`
  writeFileSync(join(skillDir, 'SKILL.md'), skillMd(AUTHOR_SKILL_NAME))
  // Cross-host skill roots OpenCode also reads from HOME.
  const [agentsSkill, claudeSkill] = AUTHOR_EXTRA_SKILL_NAMES
  for (const [root, name] of [
    ['.agents', agentsSkill],
    ['.claude', claudeSkill],
  ] as const) {
    const d = join(home, root, 'skills', name)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), skillMd(name))
  }
  // Author-level settings: a marker model that must not show up in `debug config`.
  writeFileSync(
    join(configDir, 'opencode.json'),
    JSON.stringify({ small_model: AUTHOR_CONFIG_MARKER }),
  )
  return { home, agentsMdPath, authJsonPath }
}

/** Real HOME is referenced only for the managed-config presence report. */
export function realHomeForReport(): string {
  return homedir()
}
