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
  test('strict ancestry excludes equality; non-ancestors are false', () => {
    const r = repo()
    r.write('a', '1')
    const a = r.commit('a', ['a'])
    r.write('b', '2')
    const b = r.commit('b', ['b'])
    expect(r.git.isStrictAncestor(a, b)).toBe(true)
    expect(r.git.isStrictAncestor(b, a)).toBe(false)
    expect(r.git.isStrictAncestor(a, a)).toBe(false)
    expect(r.git.isAncestorOrEqual(a, a)).toBe(true)
  })

  test('annotated vs lightweight tags are distinguished and resolve to the commit', () => {
    const r = repo()
    r.write('a', '1')
    const a = r.commit('a', ['a'])
    r.tag('t/annotated')
    r.tag('t/light', false)
    const ann = r.git.tag('t/annotated')
    const light = r.git.tag('t/light')
    expect(ann).toMatchObject({ annotated: true, commitSha: a })
    expect(ann?.objectSha).not.toBe(a)
    expect(light).toMatchObject({ annotated: false, commitSha: a, objectSha: a })
    expect(r.git.tag('t/none')).toBeNull()
  })

  test('touchedFiles lists a commit\'s own changes; commitsTouching honours the base and order', () => {
    const r = repo()
    r.write('skills/x/SKILL.md', '1')
    const c1 = r.commit('c1', ['skills/x'])
    r.write('other', '1')
    r.commit('c2', ['other'])
    r.write('skills/x/SKILL.md', '2')
    const c3 = r.commit('c3', ['skills/x'])
    expect(r.git.touchedFiles(c3)).toEqual(['skills/x/SKILL.md'])
    expect(r.git.commitsTouching(null, ['skills/x'])).toEqual([c1, c3])
    expect(r.git.commitsTouching(c1, ['skills/x'])).toEqual([c3])
    expect(r.git.parents(c3)).toHaveLength(1)
  })

  test('hashObjectPath applies EOL attributes; without them CRLF bytes hash differently', () => {
    const r = repo()
    r.write('f.json', '{}\n')
    r.commit('f', ['f.json'])
    const blob = r.git.blobAt('HEAD', 'f.json')
    r.write('f.json', '{}\r\n')
    expect(r.git.hashObjectPath('f.json')).not.toBe(blob as string)
    r.write('.gitattributes', '*.json text eol=lf\n')
    expect(r.git.hashObjectPath('f.json')).toBe(blob as string)
  })

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
