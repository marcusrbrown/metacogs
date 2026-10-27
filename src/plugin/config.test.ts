import { describe, expect, test } from 'bun:test'

import { applyConfig, skillsDirsFrom } from './config'

describe('skillsDirsFrom', () => {
  test('is the skills and plugin/skills directories beside the module directory', () => {
    expect(skillsDirsFrom('file:///opt/pkg/dist/index.js')).toEqual(['/opt/pkg/skills', '/opt/pkg/plugin/skills'])
  })

  test('decodes percent-escapes and drops the drive-letter slash', () => {
    expect(skillsDirsFrom('file:///home/me/my%20pkg/dist/index.js')).toEqual(['/home/me/my pkg/skills', '/home/me/my pkg/plugin/skills'])
    expect(skillsDirsFrom('file:///C:/Users/me/pkg/dist/index.js')).toEqual(['C:/Users/me/pkg/skills', 'C:/Users/me/pkg/plugin/skills'])
  })
})

describe('applyConfig', () => {
  const dirs = ['/pkg/skills', '/pkg/plugin/skills']

  test('an empty config gains both skill paths and no command', () => {
    const cfg: Parameters<typeof applyConfig>[0] = {}
    applyConfig(cfg, dirs)
    expect(cfg).toEqual({ skills: { paths: dirs } })
  })

  test('adds each package dir once across two config loads', () => {
    const cfg: Parameters<typeof applyConfig>[0] = {}
    applyConfig(cfg, dirs)
    applyConfig(cfg, dirs)
    expect(cfg.skills?.paths).toEqual(dirs)
  })

  test("keeps the user's own skills paths and other skills keys", () => {
    const cfg = { skills: { paths: ['/mine'], urls: ['https://example.com'] } } as Parameters<typeof applyConfig>[0]
    applyConfig(cfg, dirs)
    expect(cfg.skills).toEqual({ paths: ['/mine', ...dirs], urls: ['https://example.com'] })
  })

  test('a dir the user already lists is not added again', () => {
    const cfg: Parameters<typeof applyConfig>[0] = { skills: { paths: ['/pkg/plugin/skills'] } }
    applyConfig(cfg, dirs)
    expect(cfg.skills?.paths).toEqual(['/pkg/plugin/skills', '/pkg/skills'])
  })
})
