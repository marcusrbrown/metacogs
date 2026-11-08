/** Shared by the world tests: temp dirs, a small git repo standing in for the owner's checkout, and the command lists the permission rules are pinned against. Synthetic only. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []
export const cleanupTmp = (): void => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}
export const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'replay-world-'))
  dirs.push(d)
  return d
}

export const git = (cwd: string, args: string[], date?: string): string => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) }
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

/** A small repo standing in for the owner's checkout: main c1..c3, feat/x branching at c2, and GitHub's refs as remote-tracking refs. */
export function sourceRepo(): { dir: string; sha: Record<string, string> } {
  const dir = tmp()
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.name', 't'])
  git(dir, ['config', 'user.email', 't@example.invalid'])
  const sha: Record<string, string> = {}
  const commit = (name: string, date: string) => {
    writeFileSync(join(dir, `${name}.txt`), name)
    git(dir, ['add', '.'])
    git(dir, ['commit', '-q', '-m', name], date)
    sha[name] = git(dir, ['rev-parse', 'HEAD'])
  }
  commit('c1', '2026-01-01T12:00:00Z')
  commit('c2', '2026-02-01T12:00:00Z')
  git(dir, ['checkout', '-q', '-b', 'feat/x'])
  commit('f1', '2026-02-10T12:00:00Z')
  commit('f2', '2026-02-20T12:00:00Z')
  commit('f3', '2026-04-01T12:00:00Z')
  git(dir, ['checkout', '-q', 'main'])
  commit('c3', '2026-03-01T12:00:00Z')
  git(dir, ['update-ref', 'refs/remotes/origin/main', sha.c3!])
  git(dir, ['update-ref', 'refs/remotes/origin/feat/x', sha.f3!])
  git(dir, ['update-ref', 'refs/remotes/origin/only-remote', sha.f1!])
  return { dir, sha }
}

export const DENIED_COMMANDS = [
  'git push',
  'git push origin main',
  'git push --force-with-lease origin feat/x',
  'git -C . push',
  'git --no-pager push origin x',
  'gh pr create --fill',
  'gh pr merge 3 --squash',
  'gh pr comment 3 -b hi',
  'gh pr review 3 --approve',
  'gh pr close 3',
  'gh pr reopen 3',
  'gh pr edit 3 --title x',
  'gh issue create -t x',
  'gh issue comment 1 -b x',
  'gh issue close 1',
  'gh issue edit 1 --add-label x',
  'gh workflow run ci.yml',
  'gh run rerun 5',
  'gh run cancel 5',
  'gh release create v1',
  'gh release list',
  'gh repo view',
  'gh repo fork',
  'gh api -X POST repos/a/b/issues',
  'gh api repos/a/b/issues -X POST',
  'gh api --method PATCH repos/a/b',
  'gh api --method=DELETE repos/a/b',
  'gh api repos/a/b/issues -f title=x',
  'gh api repos/a/b -F a=b',
  'gh api graphql --field q=1',
  'gh api repos/a/b --raw-field a=b',
  'gh api repos/a/b --input body.json',
  'gh api -X GET repos/a/b -X POST',
  'gh api -X GET repos/a/b --method POST',
  'npm publish',
  'bun publish --access public',
  'changeset publish',
  'bunx changeset publish',
  'gh auth token',
  'gh auth status --show-token',
  'cat /tmp/x/gh/hosts.yml',
  'cat /tmp/x/xdg/data/opencode/auth.json',
  'env GH_REPO=a/b gh pr view 1',
  'GH_REPO=a/b gh pr create',
  'bash -c "gh pr create"',
  'FOO=1 git push origin x',
]
export const ALLOWED_COMMANDS = [
  'git log --oneline -5',
  'git status',
  'git commit -m "fix the push logic"',
  'git diff HEAD~1',
  'git fetch origin',
  'git checkout -b feat/y',
  'gh pr view 12',
  'gh pr view 12 --comments',
  'gh pr list --search auth',
  'gh pr diff 12',
  'gh pr checks 12',
  'gh pr checkout 12',
  'gh issue view 3',
  'gh issue list --state open',
  'gh run list',
  'gh run view 5 --log',
  'gh workflow list',
  'gh search prs --repo a/b x',
  'gh api repos/a/b/pulls/1',
  'gh api repos/a/b/pulls --paginate --jq ".[].title"',
  'gh api -X GET repos/a/b/issues',
  'gh api --method GET repos/a/b',
  'gh api --method=GET repos/a/b',
  'gh api repos/foo/bar-fix/pulls',
  'ls -la',
  'bun test',
  'cat README.md',
]

