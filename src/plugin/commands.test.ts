import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { COMMAND_PREFIX, COMMANDS, mergeCommands } from './commands'

const collect = () => {
  const warnings: [string, string][] = []
  return { warnings, warn: (key: string, message: string) => void warnings.push([key, message]) }
}

describe('the command templates', () => {
  test.each(['feel', 'drugs'] as const)('%s is the raw file, wraps $ARGUMENTS in <args>, and covers the empty case', (name) => {
    const { template } = COMMANDS[name]
    expect(template).toBe(readFileSync(new URL(`../../plugin/commands/${name}.md`, import.meta.url), 'utf8'))
    expect(template).toContain('<args>$ARGUMENTS</args>')
    expect(template.split('$ARGUMENTS')).toHaveLength(2)
    expect(template).toMatch(/If there is no text between the tags, choose/)
    expect(template).toContain(`\`metacogs_${name}\``)
  })

  test('feel passes the arguments as `somewhere`, drugs as `substance`', () => {
    expect(COMMANDS.feel.template).toMatch(/pass that text as one string for `somewhere`/)
    expect(COMMANDS.drugs.template).toMatch(/pass that text as one string for `substance`/)
  })

  test.each(['feel', 'drugs'] as const)('%s tells the model to drop the quotes the host puts around several words', (name) => {
    expect(COMMANDS[name].template).toContain('Several words arrive in double quotes; drop those quotes before using the text.')
  })

  test.each(['feel', 'drugs'] as const)('%s has no shell injection, file reference or HTML', (name) => {
    const { template } = COMMANDS[name]
    expect(template).not.toContain('!')
    expect(template).not.toContain('@')
    expect(template).not.toMatch(/<(?!\/?args>)/)
  })

  test('descriptions carry the prefix', () => {
    expect(COMMAND_PREFIX).toBe('(metacogs) ')
    for (const entry of Object.values(COMMANDS)) expect(entry.description.startsWith(COMMAND_PREFIX)).toBe(true)
  })
})

describe('mergeCommands', () => {
  test('an empty or missing map gains feel and drugs', () => {
    for (const existing of [undefined, {}]) {
      const { warn, warnings } = collect()
      expect(mergeCommands(existing, warn)).toEqual({ feel: COMMANDS.feel, drugs: COMMANDS.drugs })
      expect(warnings).toEqual([])
    }
  })

  test('keeps unrelated user commands', () => {
    const user = { review: { template: 'review it', description: 'mine' } }
    expect(mergeCommands(user, () => {})).toEqual({ ...user, feel: COMMANDS.feel, drugs: COMMANDS.drugs })
  })

  test('a user command without the prefix is left alone and logged once as shadowing', () => {
    const { warn, warnings } = collect()
    const user = { feel: { template: 'my feel', description: 'my own' } }
    const merged = mergeCommands(user, warn)
    expect(merged.feel).toEqual(user.feel)
    expect(merged.drugs).toEqual(COMMANDS.drugs)
    expect(warnings).toEqual([['command.feel', expect.stringContaining('feel')]])
  })

  test('a user command with no description is also the user\'s', () => {
    const merged = mergeCommands({ drugs: { template: 'mine' } }, () => {})
    expect(merged.drugs).toEqual({ template: 'mine' })
  })

  test('stale prefixed entries are dropped and re-emitted, including entries for commands that no longer exist', () => {
    const existing = {
      feel: { template: 'old body', description: `${COMMAND_PREFIX}old` },
      gone: { template: 'removed command', description: `${COMMAND_PREFIX}removed` },
    }
    const { warn, warnings } = collect()
    const merged = mergeCommands(existing, warn)
    expect(merged).toEqual({ feel: COMMANDS.feel, drugs: COMMANDS.drugs })
    expect(warnings).toEqual([])
  })

  test('is stable across repeated loads', () => {
    const once = mergeCommands(undefined, () => {})
    expect(mergeCommands(once, () => {})).toEqual(once)
  })

  test('does not mutate its input', () => {
    const existing = { feel: { template: 'old', description: `${COMMAND_PREFIX}old` } }
    mergeCommands(existing, () => {})
    expect(existing).toEqual({ feel: { template: 'old', description: `${COMMAND_PREFIX}old` } })
  })
})
