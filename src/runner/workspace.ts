/**
 * Per-run workspace: a `git init`'d directory holding only the fixture (and,
 * for the skill condition, exactly `skills/<method>/`), plus the generated
 * settings file and the allowlisted child env. Also the custody rules for
 * where run artifacts may be written.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { type PassthroughAuth, writeIsolatedAuth } from './auth'
import { cliproxyProviderConfig } from './cliproxy'
import {
  AUTH_CANARY,
  AUTHOR_SKILL_BODY,
  buildChildEnv,
  createFixture,
  destroyFixture,
  type Fixture,
  OUTSIDE_FILE_CANARY,
  plantAuthorHome,
  SENTINEL_AGENTS_MD,
} from './env'
import { providerOf, scriptedProviderConfig } from './scripted-provider'

export type Condition = 'baseline' | 'skill'
export type FixtureKind = 'dev' | 'negative' | 'heldout'

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

// ── git ────────────────────────────────────────────────────────────────────

export function gitInit(dir: string): void {
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`)
}

// ── generated settings ─────────────────────────────────────────────────────

/** Permission set from the plan's KTDs (`bash` is OpenCode's key for the shell tool). No `ask` rules. */
export function basePermission(skill: Record<string, string>): Record<string, unknown> {
  return {
    edit: 'deny',
    external_directory: 'deny',
    bash: { '*': 'deny', 'node *scripts/record.mjs*': 'allow' },
    skill,
  }
}

/**
 * The shell allowlist for a run: deny everything, then allow only the method's own helper, named by its installed path.
 * Each pattern starts with the helper path itself, so the first argument to `node` is the script and `node -e`,
 * `--eval`, `-p`, and another script ahead of the helper are all refused (probed against OpenCode 1.19.4; the looser
 * `node *scripts/record.mjs*` admitted every one of them). The path may be written relative (`.agents/skills/…`, `./…`)
 * or absolute under this run's workspace (both its spelling and its realpath), bare or in single or double quotes,
 * which covers the forms the models used. OpenCode splits `;`, `&&`, pipes and `$()` into separate commands before matching.
 */
export function helperBashRules(method: string, workspaceRoots: readonly string[]): Record<string, string> {
  const helper = `.agents/skills/${method}/scripts/record.mjs`
  const rules: Record<string, string> = { '*': 'deny' }
  const starts = [helper, `./${helper}`, ...workspaceRoots.map((root) => `${root}/${helper}`)]
  for (const quote of ['', '"', "'"]) {
    for (const start of starts) rules[`node ${quote}${start}*`] = 'allow'
  }
  return rules
}

/** Baseline sees no skill; the skill condition sees exactly the method under test. */
export function permissionFor(condition: Condition, method: string, workspaceRoots: readonly string[] = []): Record<string, unknown> {
  return {
    edit: 'deny',
    external_directory: 'deny',
    bash: helperBashRules(method, workspaceRoots),
    skill: condition === 'skill' ? { '*': 'deny', [method]: 'allow' } : { '*': 'deny' },
  }
}

export function buildConfig(input: {
  permission: Record<string, unknown>
  provider?: Record<string, unknown>
  extra?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    permission: input.permission,
    ...(input.provider ? { provider: input.provider } : {}),
    ...input.extra,
  }
}

// ── paths and custody ──────────────────────────────────────────────────────

/** `$XDG_STATE_HOME/metacogs`, falling back to `~/.local/state/metacogs`. */
export function stateRoot(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const xdg = env.XDG_STATE_HOME
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'state'), 'metacogs')
}

/**
 * Held-out fixtures live here, never in the working tree. With `repoRoot` given, a directory that resolves inside it (an
 * override pointing there, or a state root that does) is refused: the custody rule is about where the files are, not
 * how the path was spelled.
 */
export function heldoutDir(
  method: string,
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
  repoRoot?: string,
): string {
  const override = env.METACOGS_HELDOUT_DIR
  const dir = override && isAbsolute(override) ? override : join(stateRoot(env, home), 'heldout', method)
  if (repoRoot !== undefined && isInside(dir, repoRoot)) {
    throw new CustodyError(`refusing the held-out directory ${dir}: it resolves inside the repository ${repoRoot}; held-out fixtures must live outside the working tree`)
  }
  return dir
}

export interface HeldoutReadMarker {
  campaign_id: string
  started_at: string
  prereg_content_hash: string
}

/** `<state root>/heldout/<method>/<epoch>.read.json`: exists once an epoch's held-out set has been loaded for a GREEN read. */
export function heldoutReadMarkerPath(
  method: string,
  epoch: number,
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  return join(stateRoot(env, home), 'heldout', method, `${epoch}.read.json`)
}

/**
 * Claims the one-shot read: creates the marker exclusively (`wx`), so two readers cannot both succeed. An existing
 * marker means the set was already loaded for this epoch, whatever became of that run; only a new epoch gets past it.
 */
export function claimHeldoutRead(path: string, marker: HeldoutReadMarker): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    let prior = 'an earlier run'
    try {
      const read = JSON.parse(readFileSync(path, 'utf8')) as Partial<HeldoutReadMarker>
      prior = `campaign ${read.campaign_id ?? '(unknown)'} under prereg ${read.prereg_content_hash?.slice(0, 12) ?? '(unknown)'}`
    } catch {
      // an unreadable marker still blocks the read
    }
    throw new CustodyError(`the held-out set for ${marker.prereg_content_hash.slice(0, 12)} was already read by ${prior}; a new epoch with a new held-out set is the only way past it`)
  }
}

function realpathOfExistingPrefix(path: string): string {
  let current = resolve(path)
  const tail: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) break
    tail.unshift(current.slice(parent.length + 1))
    current = parent
  }
  return join(realpathSync(current), ...tail)
}

/** True when `child` resolves to `parent` or something under it (symlinks resolved on the existing prefix). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(realpathOfExistingPrefix(parent), realpathOfExistingPrefix(child))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export class CustodyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CustodyError'
  }
}

export interface OutputDirInput {
  repoRoot: string
  campaignId: string
  /** Any run touching held-out content. */
  heldout: boolean
  /** `--out`: where campaign dirs go. Held-out runs still refuse a repo-internal one. */
  outRoot?: string
  env?: Record<string, string | undefined>
  home?: string
}

/**
 * Held-out artifacts (transcripts, manifests, request bodies) go under the
 * state root and never inside the repo. Dev runs default to the gitignored
 * `evals/runs/`.
 */
export function resolveOutputDir(input: OutputDirInput): string {
  const { repoRoot, campaignId, heldout } = input
  const base = input.outRoot
    ? resolve(input.outRoot)
    : heldout
      ? join(stateRoot(input.env, input.home), 'runs')
      : join(repoRoot, 'evals', 'runs')
  const dir = join(base, campaignId)
  if (heldout && isInside(dir, repoRoot)) {
    throw new CustodyError(
      `refusing held-out run: output dir ${dir} resolves inside the repository ${repoRoot}; held-out artifacts must live under the state root`,
    )
  }
  return dir
}

// ── skills ─────────────────────────────────────────────────────────────────

export interface SkillFile {
  path: string
  sha256: string
}

function walkFiles(root: string, dir = ''): SkillFile[] {
  const out: SkillFile[] = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`skill tree contains a symlink: ${rel}`)
    if (entry.isDirectory()) out.push(...walkFiles(root, rel))
    else if (entry.isFile()) out.push({ path: rel, sha256: sha256(readFileSync(join(root, rel))) })
  }
  return out
}

/** Hash of a skill directory: sorted `path NUL sha256 LF` lines. */
export function hashSkillDir(dir: string): { sha256: string; files: SkillFile[] } {
  const files = walkFiles(dir).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { sha256: sha256(files.map((f) => `${f.path}\0${f.sha256}\n`).join('')), files }
}

/** Copies exactly the files of `skills/<method>/` (no symlinks) to `<dest>`. */
export function copySkillDir(source: string, dest: string): void {
  for (const file of walkFiles(source)) {
    const target = join(dest, file.path)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(source, file.path), target)
  }
}

// ── the run workspace ──────────────────────────────────────────────────────

export type ProviderWiring =
  | { kind: 'scripted'; url: string }
  | { kind: 'live'; recordingProxyUrl: string }

export interface RunWorkspaceInput {
  repoRoot: string
  method: string
  condition: Condition
  fixtureId: string
  fixtureText: string
  provider: ProviderWiring
  /** `provider/model`. */
  model: string
  /** Opt-in: provider entries copied into this run's isolated `auth.json` (never the author's other providers). */
  auth?: PassthroughAuth
  /** CLIProxyAPI mode: the wizard's provider blocks (`openai` and `anthropic`, both on one base URL) instead of the single model provider. */
  cliproxy?: boolean
}

/** Strings that must never be quotable from inside the run. */
export interface Decoys {
  authorHome: string
  outsideFile: string
  /** label → value; handed to `checkIsolation`. */
  needles: Record<string, string>
}

export interface RunWorkspace {
  fixture: Fixture
  config: Record<string, unknown>
  env: Record<string, string>
  expectedSkills: string[]
  skill: { sha256: string; files: SkillFile[] } | null
  decoys: Decoys
}

export function createRunWorkspace(input: RunWorkspaceInput): RunWorkspace {
  const fixture = createFixture('metacogs-run-')
  try {
    return populateRunWorkspace(input, fixture)
  } catch (e) {
    destroyFixture(fixture)
    throw e
  }
}

function populateRunWorkspace(input: RunWorkspaceInput, fixture: Fixture): RunWorkspace {
  const { repoRoot, method, condition, provider } = input
  gitInit(fixture.workspace)
  // The fixture is the whole workspace; the prompt is passed on argv with the same text.
  writeFileSync(join(fixture.workspace, 'fixture.md'), input.fixtureText)

  let skill: RunWorkspace['skill'] = null
  if (condition === 'skill') {
    const source = join(repoRoot, 'skills', method)
    if (!existsSync(join(source, 'SKILL.md'))) {
      throw new Error(`skill condition needs skills/${method}/SKILL.md`)
    }
    skill = hashSkillDir(source)
    copySkillDir(source, join(fixture.workspace, '.agents', 'skills', method))
  }
  const expectedSkills = condition === 'skill' ? [method] : []
  assertInstalledSkills(fixture.workspace, expectedSkills)

  // Decoys: what the author's machine would contribute, planted beside (not in) the
  // child's HOME. The child env never points at them; the isolation check proves
  // none of it is quotable.
  const author = plantAuthorHome(fixture.root)
  const outsideDir = join(fixture.root, 'outside')
  mkdirSync(outsideDir, { recursive: true })
  const outsideFile = join(outsideDir, 'canary.txt')
  writeFileSync(outsideFile, `${OUTSIDE_FILE_CANARY}\n`)

  const providerConfig =
    provider.kind === 'scripted'
      ? scriptedProviderConfig(provider.url)
      : input.cliproxy
        ? cliproxyProviderConfig(provider.recordingProxyUrl)
        : { [providerOf(input.model)]: { options: { baseURL: provider.recordingProxyUrl } } }
  const config = buildConfig({
    permission: permissionFor(condition, method, [...new Set([fixture.workspace, realpathSync(fixture.workspace)])]),
    provider: providerConfig,
  })
  const env = buildChildEnv({ fixture, config, withRecordsDir: true })
  writeIsolatedAuth(fixture, input.auth ?? {})

  return {
    fixture,
    config,
    env,
    expectedSkills,
    skill,
    decoys: {
      authorHome: author.home,
      outsideFile,
      needles: {
        sentinel_agents_md: SENTINEL_AGENTS_MD,
        auth_json_canary: AUTH_CANARY,
        outside_file_canary: OUTSIDE_FILE_CANARY,
        author_skill_body: AUTHOR_SKILL_BODY,
        author_home_path: author.home,
        outside_file_path: outsideFile,
      },
    },
  }
}

/** The workspace's `.agents/skills` holds exactly the expected directories, nothing else. */
export function assertInstalledSkills(workspace: string, expected: readonly string[]): void {
  const dir = join(workspace, '.agents', 'skills')
  const found = existsSync(dir) ? readdirSync(dir).sort() : []
  const want = [...expected].sort()
  if (found.join('\0') !== want.join('\0')) {
    throw new Error(`workspace skills mismatch: found [${found.join(', ')}], expected [${want.join(', ')}]`)
  }
}
