import { describe, expect, test } from 'bun:test'

import { type PublishDeps, runPublish } from './publish'

function harness(overrides: Partial<PublishDeps> = {}) {
  const publishes: number[] = []
  const logs: string[] = []
  const errors: string[] = []
  const deps: PublishDeps = {
    version: '0.2.0',
    releaseExists: () => true,
    publish: () => {
      publishes.push(1)
      return 0
    },
    log: (m) => void logs.push(m),
    error: (m) => void errors.push(m),
    ...overrides,
  }
  return { deps, publishes, logs, errors }
}

describe('runPublish', () => {
  test('without a Release for the version it skips and exits 0', () => {
    const h = harness({ releaseExists: () => false })
    expect(runPublish(h.deps)).toBe(0)
    expect(h.publishes).toEqual([])
    expect(h.logs.join('\n')).toContain('no GitHub Release for v0.2.0')
  })

  test('with a Release it publishes once and returns the command exit code', () => {
    const ok = harness()
    expect(runPublish(ok.deps)).toBe(0)
    expect(ok.publishes).toHaveLength(1)
    expect(runPublish(harness({ publish: () => 3 }).deps)).toBe(3)
  })

  test('it looks the Release up by the v-prefixed version', () => {
    const asked: string[] = []
    runPublish(harness({ releaseExists: (tag) => (asked.push(tag), true) }).deps)
    expect(asked).toEqual(['v0.2.0'])
  })

  test('a failing Release lookup exits 1, does not publish, and reports the reason', () => {
    const h = harness({
      releaseExists: () => {
        throw new Error('gh release view v0.2.0 failed: boom')
      },
    })
    expect(runPublish(h.deps)).toBe(1)
    expect(h.publishes).toEqual([])
    expect(h.errors.join('\n')).toContain('boom')
  })
})
