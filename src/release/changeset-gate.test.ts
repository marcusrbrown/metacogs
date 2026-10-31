import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  assessChangeset,
  type Change,
  type GateDeps,
  type GateEnv,
  GIT_TIMEOUT_MS,
  type GitRunner,
  gitChanges,
  isAddedChangeset,
  isGatedPath,
  parseChangesetFrontmatter,
  parseGateEnv,
  parseNameStatus,
  runGate,
  TEST_SUPPORT_FILES,
  VERSION_PR_BRANCH,
} from './changeset-gate'

const BASE = 'a'.repeat(40)
const GATE_CLI = join(import.meta.dir, 'changeset-gate.ts')

const RELEASE = "---\n'metacogs': minor\n---\n\nA change.\n"

/** `changesets` maps an added changeset's path to its text; any other path reads as a minor release of metacogs. */
function harness(changes: Change[], env: Partial<GateEnv> = {}, fail?: Error, changesets: Record<string, string> = {}) {
  const logs: string[] = []
  const errors: string[] = []
  const asked: string[] = []
  const deps: GateDeps = {
    env: { eventName: 'pull_request', headRef: 'feat/x', repository: 'o/r', headRepo: 'o/r', baseSha: BASE, ...env },
    changes: baseSha => {
      asked.push(baseSha)
      if (fail) throw fail
      return changes
    },
    readChangeset: path => changesets[path] ?? RELEASE,
    log: m => void logs.push(m),
    error: m => void errors.push(m),
  }
  return { deps, logs, errors, asked }
}

const A = (path: string): Change => ({ status: 'A', path })
const M = (path: string): Change => ({ status: 'M', path })
const D = (path: string): Change => ({ status: 'D', path })

describe('runGate', () => {
  test('fails when an owned root changes and no changeset is added', () => {
    const h = harness([M('hosts/claude/.mcp.json')])
    expect(runGate(h.deps)).toBe(1)
    expect(h.errors.join('\n')).toContain('adds no changeset')
    expect(h.errors.join('\n')).toContain('hosts/claude/.mcp.json')
    expect(h.asked).toEqual([BASE])
  })

  test('fails even when the PR hand-bumped the version, because the version field is not consulted', () => {
    const h = harness([M('package.json'), M('CHANGELOG.md'), M('.agents/plugins/marketplace.json'), M('hosts/codex/plugin.json')])
    expect(runGate(h.deps)).toBe(1)
    expect(h.errors.join('\n')).toContain('.agents/plugins/marketplace.json')
  })

  test.each(['hosts/codex/plugin.json', '.claude-plugin/plugin.json', '.agents/plugins/marketplace.json', 'src/generate/tree.ts', 'src/hosts/rules.ts', 'src/mcp/server.ts'])(
    'fails for a change to %s',
    path => {
      expect(runGate(harness([M(path)]).deps)).toBe(1)
    },
  )

  test('a deleted or added gated file is a change too', () => {
    expect(runGate(harness([D('hosts/claude/old.json')]).deps)).toBe(1)
    expect(runGate(harness([A('src/mcp/server.ts')]).deps)).toBe(1)
  })

  test('passes when the PR adds a changeset', () => {
    const h = harness([M('src/generate/tree.ts'), A('.changeset/brave-owls-sing.md')])
    expect(runGate(h.deps)).toBe(0)
    expect(h.errors).toEqual([])
    expect(h.logs.join('\n')).toContain('a changeset is added')
  })

  describe('an added changeset has to release metacogs', () => {
    const gate = (text: string) => {
      const path = '.changeset/brave-owls-sing.md'
      const h = harness([M('hosts/claude/.mcp.json'), A(path)], {}, undefined, { [path]: text })
      return { code: runGate(h.deps), errors: h.errors.join('\n') }
    }

    test('an empty changeset fails and says it releases nothing', () => {
      const { code, errors } = gate('---\n---\n\nNothing.\n')
      expect(code).toBe(1)
      expect(errors).toContain('.changeset/brave-owls-sing.md: its frontmatter is empty')
    })

    test("'metacogs': none fails and says what it needs", () => {
      const { code, errors } = gate("---\n'metacogs': none\n---\n\nx\n")
      expect(code).toBe(1)
      expect(errors).toContain('it sets metacogs to "none"; it needs patch, minor or major')
    })

    test('a changeset for other packages only fails and names them', () => {
      const { code, errors } = gate("---\n'other': patch\n'@scope/pkg': minor\n---\n\nx\n")
      expect(code).toBe(1)
      expect(errors).toContain('it declares only other packages (other, @scope/pkg), not metacogs')
    })

    test('a file with no frontmatter fails', () => {
      const { code, errors } = gate('Just prose.\n')
      expect(code).toBe(1)
      expect(errors).toContain('it has no frontmatter block')
    })

    test.each(['patch', 'minor', 'major'])("'metacogs': %s passes", bump => {
      const { code, errors } = gate(`---\n'metacogs': ${bump}\n---\n\nx\n`)
      expect(code).toBe(0)
      expect(errors).toBe('')
    })

    test('a bare metacogs: minor key passes, and so does a double-quoted one', () => {
      expect(gate('---\nmetacogs: minor\n---\n\nx\n').code).toBe(0)
      expect(gate('---\n"metacogs": patch\n---\n\nx\n').code).toBe(0)
    })

    test('one releasing changeset among rejected ones is enough', () => {
      const h = harness([M('hosts/claude/.mcp.json'), A('.changeset/a.md'), A('.changeset/b.md')], {}, undefined, { '.changeset/a.md': '---\n---\n' })
      expect(runGate(h.deps)).toBe(0)
    })

    test('with several rejected changesets, each is named', () => {
      const h = harness([M('hosts/claude/.mcp.json'), A('.changeset/a.md'), A('.changeset/b.md')], {}, undefined, {
        '.changeset/a.md': '---\n---\n',
        '.changeset/b.md': "---\n'metacogs': none\n---\n",
      })
      expect(runGate(h.deps)).toBe(1)
      expect(h.errors.join('\n')).toMatch(/a\.md: its frontmatter is empty[\s\S]*b\.md: it sets metacogs to "none"/)
    })

    test('an unreadable changeset fails the gate', () => {
      const h = harness([M('hosts/claude/.mcp.json'), A('.changeset/a.md')])
      h.deps.readChangeset = () => {
        throw new Error('boom')
      }
      expect(runGate(h.deps)).toBe(1)
      expect(h.errors.join('\n')).toContain('could not read .changeset/a.md: boom')
    })

    test('the changeset is not read when nothing gated changed', () => {
      const h = harness([M('README.md'), A('.changeset/a.md')])
      h.deps.readChangeset = () => {
        throw new Error('should not be read')
      }
      expect(runGate(h.deps)).toBe(0)
    })
  })

  test.each([
    ['the changeset README', A('.changeset/README.md')],
    ['a modified existing changeset', M('.changeset/old-one.md')],
    ['a deleted changeset', D('.changeset/old-one.md')],
    ['a nested markdown file', A('.changeset/sub/x.md')],
    ['the config file', A('.changeset/config.json')],
    ['a changeset-looking file elsewhere', A('docs/.changeset/x.md')],
  ])('%s does not count as a new changeset', (_name, change) => {
    expect(runGate(harness([M('hosts/claude/.mcp.json'), change]).deps)).toBe(1)
  })

  test('passes the version PR by its branch', () => {
    const h = harness([M('hosts/claude/.claude-plugin/plugin.json'), M('package.json')], { headRef: VERSION_PR_BRANCH })
    expect(runGate(h.deps)).toBe(0)
    expect(h.asked).toEqual([])
    expect(h.logs.join('\n')).toContain('version PR')
  })

  test.each([
    ['a fork using that branch name', { headRepo: 'fork/r' }],
    ['a missing head repo', { headRepo: undefined }],
    ['a similar branch name', { headRef: 'changeset-release/main-2' }],
    ['a prefix of the branch name', { headRef: 'changeset-release' }],
  ])('does not exempt %s', (_name, env) => {
    expect(runGate(harness([M('hosts/codex/plugin.json')], { headRef: VERSION_PR_BRANCH, ...env }).deps)).toBe(1)
  })

  test('passes changes outside the gated paths', () => {
    const h = harness([M('README.md'), M('src/release/changeset-gate.ts'), M('src/generated-lookalike.ts'), M('hosts/readme.md'), M('skills/synthesis/scripts/record.mjs'), M('docs/plans/x.md')])
    expect(runGate(h.deps)).toBe(0)
    expect(h.logs.join('\n')).toContain('no generated host output')
  })

  test('passes a PR with no changes', () => {
    expect(runGate(harness([]).deps)).toBe(0)
  })

  test.each(['push', 'workflow_dispatch', 'schedule', undefined])('skips on %s without reading git', eventName => {
    const h = harness([M('hosts/claude/.mcp.json')], { eventName, baseSha: undefined })
    expect(runGate(h.deps)).toBe(0)
    expect(h.asked).toEqual([])
    expect(h.logs.join('\n')).toContain('skipped')
  })

  test('a pull_request with no base SHA is an error, not a pass', () => {
    const h = harness([], { baseSha: undefined })
    expect(runGate(h.deps)).toBe(1)
    expect(h.errors.join('\n')).toContain('PR_BASE_SHA')
  })

  test('a git failure fails the gate and says why', () => {
    const h = harness([], {}, new Error('git fetch origin failed: boom'))
    expect(runGate(h.deps)).toBe(1)
    expect(h.errors.join('\n')).toContain('boom')
  })
})

describe('path rules', () => {
  test('gated prefixes are directories, not string prefixes', () => {
    expect(isGatedPath('src/mcp/server.ts')).toBe(true)
    expect(isGatedPath('src/mcpx/server.ts')).toBe(false)
    expect(isGatedPath('src/hosts')).toBe(false)
    expect(isGatedPath('hosts/claudette/x')).toBe(false)
  })

  test('test files under a gated prefix are not gated, so a test-only change needs no changeset', () => {
    expect(isGatedPath('src/hosts/foo.test.ts')).toBe(false)
    expect(isGatedPath('src/generate/tree.test.ts')).toBe(false)
    expect(isGatedPath('src/hosts/rules.ts')).toBe(true)
    expect(runGate(harness([M('src/hosts/foo.test.ts')]).deps)).toBe(0)
    expect(runGate(harness([M('src/hosts/foo.test.ts'), M('src/hosts/rules.ts')]).deps)).toBe(1)
  })

  test.each(['src/plugin/index.ts', 'src/frames/feel-drugs.ts', 'plugin/guidance.md', 'plugin/skills/feel/SKILL.md'])('a non-test change to %s needs a changeset', path => {
    expect(isGatedPath(path)).toBe(true)
    expect(runGate(harness([M(path)]).deps)).toBe(1)
    expect(runGate(harness([M(path), A('.changeset/x.md')]).deps)).toBe(0)
  })

  test.each(['src/plugin/v2.test.ts', 'src/frames/feel-drugs.test.ts'])('a test-only change to %s needs no changeset', path => {
    expect(isGatedPath(path)).toBe(false)
    expect(runGate(harness([M(path)]).deps)).toBe(0)
  })

  test.each([...TEST_SUPPORT_FILES])('a change to the test harness %s needs no changeset', path => {
    expect(isGatedPath(path)).toBe(false)
    expect(runGate(harness([M(path)]).deps)).toBe(0)
  })

  test('the plugin prefixes are directories: src/plugins and pluginx are not gated', () => {
    expect(isGatedPath('src/plugins/x.ts')).toBe(false)
    expect(isGatedPath('pluginx/guidance.md')).toBe(false)
  })

  test('parseChangesetFrontmatter reads the block between the leading --- lines', () => {
    const parsed = parseChangesetFrontmatter("---\r\n'metacogs': minor\r\nother: patch # why\r\n---\r\nbody: not read\r\n")
    expect(parsed.ok && [...parsed.entries]).toEqual([
      ['metacogs', 'minor'],
      ['other', 'patch'],
    ])
    expect(parseChangesetFrontmatter('body\n---\nmetacogs: minor\n---\n')).toEqual({ ok: false, reason: 'it has no frontmatter block' })
    expect(parseChangesetFrontmatter('---\nmetacogs: minor\n')).toEqual({ ok: false, reason: 'it has no frontmatter block' })
    expect(assessChangeset("---\n'metacogs': \"patch\"\n---\n")).toEqual({ releases: true })
  })

  describe('only top-level entries count', () => {
    const verdict = (frontmatter: string) => assessChangeset(`---\n${frontmatter}---\n\nbody\n`)
    const rejected = (frontmatter: string, why: RegExp) => {
      const result = verdict(frontmatter)
      expect(result.releases).toBe(false)
      expect(result.releases === false && result.reason).toMatch(why)
    }

    test('metacogs: patch nested under another key is rejected', () => {
      // The parent key has no value on its own line, so that line is the first to fail.
      rejected('other:\n  metacogs: patch\n', /plain "name: bump" lines at column 0/)
      rejected("'other':\n  'metacogs': patch\n", /plain "name: bump" lines at column 0/)
      rejected('metacogs: minor\n  nested: patch\n', /indented line/)
      rejected('\tmetacogs: minor\n', /indented line/)
    })

    test('metacogs: patch inside a block scalar is rejected', () => {
      rejected('other: |\n  metacogs: patch\n', /block scalar/)
      rejected('other: >-\n  metacogs: patch\n', /block scalar/)
      rejected('metacogs: |\n', /block scalar/)
    })

    test('flow mappings and sequences are rejected', () => {
      rejected('other: { metacogs: patch }\n', /flow mapping or sequence/)
      rejected('other: [metacogs, patch]\n', /flow mapping or sequence/)
      rejected('{ metacogs: patch }\n', /not a top-level key: value/)
    })

    test('a line that is not a top-level key: value rejects the whole block, even beside a valid release', () => {
      rejected('metacogs: minor\njust prose\n', /not a top-level key: value/)
      rejected('metacogs: minor\n- metacogs\n', /not a top-level key: value/)
      rejected('metacogs: minor\n# a comment\n', /not a top-level key: value/)
      rejected('metacogs: minor\nmetacogs: none\n', /duplicate name/)
      rejected('metacogs:\n', /not a top-level key: value/)
    })

    test('the plain forms still pass, with blank lines, CRLF and a trailing comment', () => {
      expect(verdict("'metacogs': patch\n")).toEqual({ releases: true })
      expect(verdict('"metacogs": major\n')).toEqual({ releases: true })
      expect(verdict('metacogs: minor # why\n\n')).toEqual({ releases: true })
      expect(assessChangeset("---\r\n'other': patch\r\nmetacogs: minor\r\n---\r\n")).toEqual({ releases: true })
    })

    test('empty and none still fail with their own reasons', () => {
      rejected('', /frontmatter is empty/)
      rejected('\n', /frontmatter is empty/)
      rejected("'metacogs': none\n", /needs patch, minor or major/)
    })
  })

  test('isAddedChangeset needs status A, a direct .changeset/*.md child, and not the README', () => {
    expect(isAddedChangeset(A('.changeset/x.md'))).toBe(true)
    expect(isAddedChangeset(M('.changeset/x.md'))).toBe(false)
    expect(isAddedChangeset(A('.changeset/README.md'))).toBe(false)
    expect(isAddedChangeset(A('.changeset/x.txt'))).toBe(false)
  })

  test('parseGateEnv reads the Actions variables and treats empty as unset', () => {
    expect(
      parseGateEnv({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_HEAD_REF: '', GITHUB_REPOSITORY: 'o/r', PR_HEAD_REPO: 'o/r', PR_BASE_SHA: BASE }),
    ).toEqual({ eventName: 'pull_request', headRef: undefined, repository: 'o/r', headRepo: 'o/r', baseSha: BASE })
  })

  test('parseNameStatus reads NUL-separated pairs, including paths with spaces and newlines', () => {
    expect(parseNameStatus('M\0a b.txt\0A\0odd\nname.md\0D\0gone.txt\0')).toEqual([M('a b.txt'), A('odd\nname.md'), D('gone.txt')])
    expect(parseNameStatus('')).toEqual([])
  })
})

describe('git timeout', () => {
  const timedOut = { status: null, stdout: '', stderr: '', error: new Error('spawnSync git ETIMEDOUT') } as unknown as ReturnType<GitRunner>

  test('every git call carries a 120 s timeout', () => {
    expect(GIT_TIMEOUT_MS).toBe(120_000)
    const timeouts: (number | undefined)[] = []
    const run: GitRunner = (_command, _args, options) => {
      timeouts.push(options.timeout)
      return { status: 0, stdout: '', stderr: '' } as unknown as ReturnType<GitRunner>
    }
    expect(gitChanges('/unused', run)(BASE)).toEqual([])
    // cat-file, then diff: the base is present, so no fetch.
    expect(timeouts).toEqual([GIT_TIMEOUT_MS, GIT_TIMEOUT_MS])
  })

  test('a timed-out git throws, and the gate turns that into exit 1', () => {
    const changes = gitChanges('/unused', () => timedOut)
    expect(() => changes(BASE)).toThrow(/could not run git: spawnSync git ETIMEDOUT/)
    const errors: string[] = []
    const code = runGate({ env: { eventName: 'pull_request', headRef: 'feat/x', repository: 'o/r', headRepo: 'o/r', baseSha: BASE }, changes, readChangeset: () => '', log: () => {}, error: m => void errors.push(m) })
    expect(code).toBe(1)
    expect(errors.join('\n')).toContain('could not diff against')
  })
})

// Real git, on a throwaway repository. Never the live checkout.
describe('gitChanges and the CLI over a fixture repository', () => {
  let repo: string
  let base: string

  const git = (args: string[], cwd = repo) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  const commit = (message: string) => {
    git(['add', '-A'])
    git(['commit', '-q', '-m', message])
  }
  const cli = (env: Record<string, string>) =>
    spawnSync('bun', [GATE_CLI], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: repo, ...env } })
  const prEnv = (extra: Record<string, string> = {}) => ({
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_HEAD_REF: 'feat/x',
    GITHUB_REPOSITORY: 'o/r',
    PR_HEAD_REPO: 'o/r',
    PR_BASE_SHA: base,
    ...extra,
  })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'metacogs-gate-'))
    git(['init', '-q', '-b', 'main'])
    put('README.md', 'x\n')
    put('.changeset/README.md', 'x\n')
    put('hosts/claude/.mcp.json', '{}\n')
    put('src/generate/tree.ts', 'export {}\n')
    commit('base')
    base = git(['rev-parse', 'HEAD'])
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test('lists added, modified and deleted files since the base, with renames split', () => {
    put('hosts/claude/new.json', '{}\n')
    put('src/generate/tree.ts', 'export const a = 1\n')
    git(['rm', '-q', 'hosts/claude/.mcp.json'])
    git(['mv', 'README.md', 'README2.md'])
    commit('change')
    const changes = gitChanges(repo)(base)
    const key = (c: Change) => `${c.status} ${c.path}`
    expect(changes.map(key).sort()).toEqual(['A README2.md', 'A hosts/claude/new.json', 'D README.md', 'D hosts/claude/.mcp.json', 'M src/generate/tree.ts'])
  })

  test('rejects a base that is not a full SHA before it reaches git', () => {
    expect(() => gitChanges(repo)('--upload-pack=evil')).toThrow(/not a commit SHA/)
    expect(() => gitChanges(repo)('main')).toThrow(/not a commit SHA/)
  })

  test('a base that is absent and cannot be fetched is an error', () => {
    expect(() => gitChanges(repo)('b'.repeat(40))).toThrow(/git fetch origin/)
  })

  test('fetches an absent base explicitly from origin, as a shallow checkout needs', () => {
    const origin = repo
    put('hosts/claude/.mcp.json', '{"v":2}\n')
    commit('pr change')
    const head = git(['rev-parse', 'HEAD'])
    const shallow = mkdtempSync(join(tmpdir(), 'metacogs-gate-shallow-'))
    try {
      git(['clone', '-q', '--depth=1', `file://${origin}`, shallow], tmpdir())
      // The clone holds only HEAD, so the base commit is not present locally.
      expect(spawnSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd: shallow }).status).not.toBe(0)
      expect(gitChanges(shallow)(base)).toEqual([M('hosts/claude/.mcp.json')])
      expect(git(['rev-parse', 'HEAD'], shallow)).toBe(head)
    } finally {
      rmSync(shallow, { recursive: true, force: true })
    }
  })

  test('CLI: fails with exit 1 on a host-output change without a changeset, and names the path', () => {
    put('hosts/claude/.mcp.json', '{"v":2}\n')
    put('package.json', '{"version":"9.9.9"}\n')
    commit('bump by hand')
    const r = cli(prEnv())
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('adds no changeset')
    expect(r.stderr).toContain('hosts/claude/.mcp.json')
  })

  test('CLI: passes with a changeset', () => {
    put('hosts/claude/.mcp.json', '{"v":2}\n')
    put('.changeset/calm-cats-nap.md', "---\n'metacogs': patch\n---\n\nx\n")
    commit('with changeset')
    const r = cli(prEnv())
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('a changeset is added')
  })

  test('CLI: an empty changeset reads from HEAD and fails, saying why', () => {
    put('hosts/claude/.mcp.json', '{"v":2}\n')
    put('.changeset/empty-owls.md', '---\n---\n')
    commit('with empty changeset')
    const r = cli(prEnv())
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('.changeset/empty-owls.md: its frontmatter is empty')
  })

  test('CLI: passes the version PR branch, and passes a change outside the owned paths', () => {
    put('hosts/claude/.mcp.json', '{"v":2}\n')
    commit('version commit')
    expect(cli(prEnv({ GITHUB_HEAD_REF: VERSION_PR_BRANCH })).status).toBe(0)
    expect(cli(prEnv({ GITHUB_HEAD_REF: VERSION_PR_BRANCH, PR_HEAD_REPO: 'fork/r' })).status).toBe(1)

    git(['reset', '-q', '--hard', base])
    put('README.md', 'changed\n')
    commit('docs only')
    expect(cli(prEnv()).status).toBe(0)
  })

  test('CLI: skips off pull_request even with gated changes and no base', () => {
    put('hosts/claude/.mcp.json', '{"v":2}\n')
    commit('push to main')
    const r = cli({ GITHUB_EVENT_NAME: 'push' })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('skipped')
  })
})
