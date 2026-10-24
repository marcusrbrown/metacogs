import { afterEach, describe, expect, test } from 'bun:test'

import { GitError } from './git'
import { TestRepo } from './test-support'

const repos: TestRepo[] = []
const repo = () => {
  const r = new TestRepo()
  repos.push(r)
  return r
}
afterEach(() => {
  for (const r of repos.splice(0)) r.destroy()
})

describe('Git wrapper', () => {
  test('unresolvable revs are null; failing commands throw GitError', () => {
    const r = repo()
    expect(r.git.revParse('nope')).toBeNull()
    expect(() => r.git.run(['rev-parse', '--verify', 'nope'])).toThrow(GitError)
  })

  test('porcelain reports uncommitted and untracked paths only for the given scope', () => {
    const r = repo()
    r.write('skills/x/a', '1')
    r.commit('a', ['skills/x'])
    expect(r.git.porcelain(['skills/x'])).toBe('')
    r.write('skills/x/new', '1')
    r.write('elsewhere', '1')
    expect(r.git.porcelain(['skills/x'])).toContain('skills/x/new')
    expect(r.git.porcelain(['skills/x'])).not.toContain('elsewhere')
  })
})
