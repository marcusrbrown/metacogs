import { describe, expect, test } from 'bun:test'

import { runRelease, type ReleaseDeps } from './release'

const CHANGELOG = '# metacogs\n\n## 0.1.1\n\n- fix\n\n## 0.1.0\n\n- first\n'

function harness(overrides: Partial<ReleaseDeps> = {}) {
  const created: Parameters<ReleaseDeps['createRelease']>[0][] = []
  const logs: string[] = []
  const errors: string[] = []
  const deps: ReleaseDeps = {
    version: '0.1.1',
    changelog: CHANGELOG,
    introducingSha: () => 'abc123',
    headSha: () => 'head999',
    releaseExists: () => false,
    createRelease: (r) => void created.push(r),
    log: (m) => void logs.push(m),
    error: (m) => void errors.push(m),
    ...overrides,
  }
  return { deps, created, logs, errors }
}

describe('runRelease', () => {
  test('an existing Release is a no-op', () => {
    const h = harness({ releaseExists: (tag) => tag === 'v0.1.1' })
    expect(runRelease(h.deps)).toBe(0)
    expect(h.created).toEqual([])
    expect(h.logs.join('\n')).toContain('v0.1.1 already has a GitHub Release')
  })

  test('no Release and a changelog section creates the Release at the given sha', () => {
    const h = harness()
    expect(runRelease(h.deps)).toBe(0)
    expect(h.created).toEqual([{ tag: 'v0.1.1', sha: 'abc123', notes: '- fix', prerelease: false }])
  })

  test('the Release targets the commit that introduced the version, not HEAD', () => {
    const h = harness({ introducingSha: () => 'intro42' })
    expect(runRelease(h.deps)).toBe(0)
    expect(h.created[0]?.sha).toBe('intro42')
    expect(h.logs.join('\n')).not.toContain('targeting HEAD')
  })

  test('falls back to HEAD and logs it when no introducing commit is found', () => {
    const h = harness({ introducingSha: () => null })
    expect(runRelease(h.deps)).toBe(0)
    expect(h.created[0]?.sha).toBe('head999')
    expect(h.logs.join('\n')).toContain('targeting HEAD (head999)')
  })

  test('a prerelease version is created as a prerelease', () => {
    const h = harness({ version: '1.0.0-rc.1', changelog: '## 1.0.0-rc.1\n\n- rc\n' })
    expect(runRelease(h.deps)).toBe(0)
    expect(h.created[0]).toMatchObject({ tag: 'v1.0.0-rc.1', prerelease: true })
  })

  test('no Release and no changelog section is a no-op with a notice', () => {
    const h = harness({ version: '0.2.0' })
    expect(runRelease(h.deps)).toBe(0)
    expect(h.created).toEqual([])
    expect(h.logs.join('\n')).toContain('notice')
    expect(h.logs.join('\n')).toContain('## 0.2.0')
  })

  test('a missing CHANGELOG.md is the same no-op', () => {
    const h = harness({ changelog: null })
    expect(runRelease(h.deps)).toBe(0)
    expect(h.created).toEqual([])
  })

  test('a failed create exits non-zero and names the tag', () => {
    const h = harness({
      createRelease: () => {
        throw new Error('gh release create v0.1.1 failed: HTTP 422')
      },
    })
    expect(runRelease(h.deps)).toBe(1)
    expect(h.errors.join('\n')).toContain('v0.1.1')
  })

  test('a failed existence check exits non-zero without creating', () => {
    const h = harness({
      releaseExists: () => {
        throw new Error('gh release view v0.1.1 failed: bad credentials')
      },
    })
    expect(runRelease(h.deps)).toBe(1)
    expect(h.created).toEqual([])
    expect(h.errors.join('\n')).toContain('v0.1.1')
  })
})
