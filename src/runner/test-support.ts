/**
 * Shared test helpers for the runner: a hermetic temp git repo and a valid
 * prereg builder. Not imported by production code.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Git } from './git'
import { canonicalizeText, type Prereg, RUN_OUTCOME_TAXONOMY, saltedHash } from './prereg'

export const TEST_SALT = 'test-salt-0123'

/** HOME and XDG_CONFIG_HOME point at an empty dir so a developer's global git attributes (e.g. `* text=auto eol=lf`) cannot change hash-object results. */
const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'metacogs-empty-home-'))

export function hermeticGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: EMPTY_HOME,
    XDG_CONFIG_HOME: EMPTY_HOME,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
  }
}

export class TestRepo {
  readonly dir: string
  readonly git: Git
  private readonly env = hermeticGitEnv()

  constructor(prefix = 'metacogs-repo-') {
    this.dir = mkdtempSync(join(tmpdir(), prefix))
    this.sh(['init', '-q', '-b', 'main'])
    this.sh(['config', 'core.autocrlf', 'false'])
    this.sh(['config', 'commit.gpgsign', 'false'])
    this.git = new Git(this.dir, this.env)
  }

  sh(args: string[]): string {
    const r = spawnSync('git', ['-C', this.dir, ...args], { encoding: 'utf8', env: this.env })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }

  write(path: string, content: string | Uint8Array): void {
    const full = join(this.dir, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  /** Commit exactly `paths` (written beforehand). Returns the commit SHA. */
  commit(message: string, paths: string[]): string {
    this.sh(['add', '--', ...paths])
    this.sh(['commit', '-q', '-m', message, '--allow-empty'])
    return this.sh(['rev-parse', 'HEAD'])
  }

  head(): string {
    return this.sh(['rev-parse', 'HEAD'])
  }

  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}

export interface MethodScaffold {
  method: string
  heldoutDir: string
  prereg: Prereg
  /** Paths of the fixture + rubric files, for committing as step (1). */
  fixturePaths: string[]
  preregPath: string
}

const DEV_TEXT = 'Dev fixture: choose a database for the service.\n'
const NEG_TEXT = 'Negative fixture: fix the typo in README.\n'
const HELD_TEXT = 'Held-out fixture: pick a queue.\n'
const RUBRIC_TEXT = '# Rubric\n\n1. names an assumption\n'

/** Writes fixtures, rubric, and held-out content for `method`; returns a prereg that matches them. */
export function scaffoldMethod(
  repo: TestRepo,
  method: string,
  options: { epoch?: number; heldoutDir: string; overrides?: Partial<Prereg> },
): MethodScaffold {
  const epoch = options.epoch ?? 1
  const dir = `evals/${method}`
  const files: Record<string, string> = {
    [`${dir}/fixtures/dev/d1.md`]: DEV_TEXT,
    [`${dir}/fixtures/negative/n1.md`]: NEG_TEXT,
    [`${dir}/rubric.md`]: RUBRIC_TEXT,
    [`${dir}/redact.json`]: '{"tokens":[]}\n',
  }
  for (const [path, content] of Object.entries(files)) repo.write(path, content)
  mkdirSync(options.heldoutDir, { recursive: true })
  writeFileSync(join(options.heldoutDir, 'h1.md'), HELD_TEXT)

  const h = (text: string) => saltedHash(TEST_SALT, canonicalizeText(text))
  const prereg: Prereg = {
    schema_version: 1,
    method,
    epoch,
    salt: TEST_SALT,
    fixture_hashes: { dev: { d1: h(DEV_TEXT) }, negative: { n1: h(NEG_TEXT) }, heldout: { h1: h(HELD_TEXT) } },
    rubric_hash: h(RUBRIC_TEXT),
    runs_per_condition: 2,
    red_bar: { min_baseline_fails_per_fixture: 4, min_fixtures: 2 },
    green_bar: { skill_pooled_pass_min: 17, skill_per_fixture_pass_min: 3, baseline_pooled_pass_max: 10 },
    false_fire_max: 0,
    per_run_timeout_ms: 60_000,
    budget: { max_tool_calls: 20, max_total_tokens: 200_000 },
    infra_error_definition: 'Provider or host outage before skill content loads.',
    run_outcome_taxonomy: [...RUN_OUTCOME_TAXONOMY],
    agreement_floor: 0.8,
    agent_model_id: 'opencode/big-pickle',
    judge_model_id: 'judge/other-family',
    accepted_error_rates: { false_red: 0.1, false_green: 0.22 },
    metadata: { source_url: 'https://example.invalid/synthetic', licence: 'MIT' },
    ...options.overrides,
  }
  return {
    method,
    heldoutDir: options.heldoutDir,
    prereg,
    fixturePaths: Object.keys(files),
    preregPath: `${dir}/prereg.json`,
  }
}

export function writePrereg(repo: TestRepo, scaffold: MethodScaffold, prereg: Prereg = scaffold.prereg, eol = '\n'): void {
  repo.write(scaffold.preregPath, `${JSON.stringify(prereg, null, 2)}\n`.replace(/\n/g, eol))
}

/** The happy path: fixtures, rubric and prereg committed, then the skill. */
export function buildHappyChain(repo: TestRepo, scaffold: MethodScaffold, extraSkillFiles: Record<string, string> = {}) {
  writePrereg(repo, scaffold)
  const preregCommit = repo.commit('test: fixtures, rubric and prereg', [...scaffold.fixturePaths, scaffold.preregPath])
  repo.write(`skills/${scaffold.method}/SKILL.md`, `---\nname: ${scaffold.method}\ndescription: test skill\n---\n\nbody\n`)
  for (const [rel, content] of Object.entries(extraSkillFiles)) repo.write(`skills/${scaffold.method}/${rel}`, content)
  const skillCommit = repo.commit('test: skill', [`skills/${scaffold.method}`])
  return { preregCommit, skillCommit }
}
