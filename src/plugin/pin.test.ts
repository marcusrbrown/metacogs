import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadMatrix, REPO_ROOT } from '../matrix/check'
import { OPENCODE_PIN } from '../runner/env'

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8')

describe('the tested OpenCode version', () => {
  test('package.json testedWith, the matrix OpenCode plugin entry and the runner pin are one version', () => {
    const pkg = JSON.parse(read('package.json')) as { testedWith?: Record<string, string> }
    const { matrix } = loadMatrix(REPO_ROOT)
    expect(pkg.testedWith?.opencode).toBe(OPENCODE_PIN)
    expect(matrix?.plugins?.opencode?.host_version).toBe(OPENCODE_PIN)
  })

  test('the OpenCode v2 pin is testedWith["opencode-v2"], the one source, and equals the @opencode/plugin devDependency', () => {
    const pkg = JSON.parse(read('package.json')) as { testedWith?: Record<string, string>; devDependencies?: Record<string, string> }
    expect(Object.keys(pkg.testedWith ?? {}).sort()).toEqual(['opencode', 'opencode-v2'])
    expect(pkg.testedWith?.['opencode-v2']).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pkg.testedWith?.['opencode-v2']).toBe(pkg.devDependencies?.['@opencode/plugin'])
  })
})

describe('the docs that state the tested version', () => {
  test.each(['README.md', 'docs/install.md'])('%s names OpenCode at the pinned version', (file) => {
    expect(read(file)).toContain(`OpenCode ${OPENCODE_PIN}`)
  })
})

describe('package.json publishing fields', () => {
  const pkg = JSON.parse(read('package.json')) as Record<string, unknown>

  test('the package is public, with provenance, and its repository matches the GitHub repository exactly', () => {
    expect(pkg.private).toBeUndefined()
    expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true })
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/marcusrbrown/metacogs.git' })
    expect(pkg.bugs).toEqual({ url: 'https://github.com/marcusrbrown/metacogs/issues' })
    expect(pkg.homepage).toBe('https://github.com/marcusrbrown/metacogs#readme')
  })

  test('changesets publishes publicly', () => {
    expect((JSON.parse(read('.changeset/config.json')) as { access: string }).access).toBe('public')
  })
})
