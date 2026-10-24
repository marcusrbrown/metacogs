import { describe, expect, test } from 'bun:test'

import { extractChangelogSection } from './changelog'

const log = `# metacogs

## 0.1.1

### Patch Changes

- fix the thing

## 0.1.0

### Minor Changes

- first
`

describe('extractChangelogSection', () => {
  test('returns only the requested version body', () => {
    const section = extractChangelogSection(log, '0.1.1')
    expect(section).toEqual({ body: '### Patch Changes\n\n- fix the thing', prerelease: false })
  })

  test('the last section runs to the end of the file', () => {
    expect(extractChangelogSection(log, '0.1.0')?.body).toBe('### Minor Changes\n\n- first')
  })

  test('a version with a prerelease suffix sets the flag and matches exactly', () => {
    const pre = '## 1.0.0-beta.1\n\n- beta\n\n## 1.0.0\n\n- stable\n'
    expect(extractChangelogSection(pre, '1.0.0-beta.1')).toEqual({ body: '- beta', prerelease: true })
    expect(extractChangelogSection(pre, '1.0.0')).toEqual({ body: '- stable', prerelease: false })
  })

  test('no matching section is null', () => {
    expect(extractChangelogSection(log, '0.2.0')).toBeNull()
    expect(extractChangelogSection('', '0.1.0')).toBeNull()
    expect(extractChangelogSection('## 0.1.10\n\n- x\n', '0.1.1')).toBeNull()
  })

  test('CRLF files parse the same', () => {
    expect(extractChangelogSection(log.replaceAll('\n', '\r\n'), '0.1.1')?.body).toBe('### Patch Changes\n\n- fix the thing')
  })
})
