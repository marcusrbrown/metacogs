import { describe, expect, test } from 'bun:test'

import { COMMANDS } from './commands'
import { applyConfig, skillsDirFrom } from './config'

const noop = () => {}

describe('skillsDirFrom', () => {
  test('is the skills directory beside the module directory', () => {
    expect(skillsDirFrom('file:///opt/pkg/dist/index.js')).toBe('/opt/pkg/skills')
  })

  test('decodes percent-escapes and drops the drive-letter slash', () => {
    expect(skillsDirFrom('file:///home/me/my%20pkg/dist/index.js')).toBe('/home/me/my pkg/skills')
    expect(skillsDirFrom('file:///C:/Users/me/pkg/dist/index.js')).toBe('C:/Users/me/pkg/skills')
  })
})

describe('applyConfig', () => {
  test('an empty config gains both commands and the skills path', () => {
    const cfg: Parameters<typeof applyConfig>[0] = {}
    applyConfig(cfg, '/pkg/skills', noop)
    expect(cfg.command).toEqual({ feel: COMMANDS.feel, drugs: COMMANDS.drugs })
    expect(cfg.skills).toEqual({ paths: ['/pkg/skills'] })
  })

  test('adds the package dir once across two config loads', () => {
    const cfg: Parameters<typeof applyConfig>[0] = {}
    applyConfig(cfg, '/pkg/skills', noop)
    applyConfig(cfg, '/pkg/skills', noop)
    expect(cfg.skills?.paths).toEqual(['/pkg/skills'])
    expect(Object.keys(cfg.command ?? {}).sort()).toEqual(['drugs', 'feel'])
  })

  test('keeps the user\'s own skills paths and other skills keys', () => {
    const cfg = { skills: { paths: ['/mine'], urls: ['https://example.com'] } } as Parameters<typeof applyConfig>[0]
    applyConfig(cfg, '/pkg/skills', noop)
    expect(cfg.skills).toEqual({ paths: ['/mine', '/pkg/skills'], urls: ['https://example.com'] })
  })

  test('a user command with the same name is untouched and logged once', () => {
    const warnings: string[] = []
    const cfg: Parameters<typeof applyConfig>[0] = { command: { feel: { template: 'mine', description: 'mine' } } }
    applyConfig(cfg, '/pkg/skills', (key) => void warnings.push(key))
    expect(cfg.command?.feel).toEqual({ template: 'mine', description: 'mine' })
    expect(cfg.command?.drugs).toEqual(COMMANDS.drugs)
    expect(warnings).toEqual(['command.feel'])
  })
})
