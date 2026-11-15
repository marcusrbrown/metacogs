import { describe, expect, test } from 'bun:test'

import { EMAIL_PLACEHOLDER, SCRUB_PLACEHOLDER } from './mask'
import { PATH_PLACEHOLDER, redactAbsolutePaths, scrubFindings } from './scrub'

// Assembled at runtime so this file holds no credential-shaped literal.
const VALUE = ['v4lue', 'Of', 'Some', 'Length'].join('')

const KEYS = ['password', 'passwd', 'pwd', 'secret', 'token', 'api_key', 'api-key', 'apikey', 'access_key', 'auth', 'authorization', 'cookie', 'db_password', 'X_AUTH_TOKEN', 'client_secret', 'private_key', 'credentials'] as const

describe('scrubFindings: credential fields', () => {
  const forms: [string, (key: string, value: string) => string][] = [
    ['key=value', (key, value) => `${key}=${value}`],
    ['key: value', (key, value) => `${key}: ${value}`],
    ['key = value with spaces', (key, value) => `${key} = ${value}`],
    ['quoted JSON', (key, value) => `{"${key}": "${value}"}`],
    ['quoted JSON without a space', (key, value) => `{"${key}":"${value}"}`],
    ['single-quoted', (key, value) => `{'${key}': '${value}'}`],
    ['a short quoted value', (key) => `{"${key}": "pw"}`],
    ['a quoted value with spaces', (key) => `{"${key}": "a long pass phrase"}`],
  ]

  for (const [formName, form] of forms) {
    test(`every key is found in the form ${formName}, in any case`, () => {
      for (const key of KEYS) {
        for (const spelled of [key, key.toUpperCase(), key.replace(/^./, (c) => c.toUpperCase())]) {
          expect([spelled, [...scrubFindings(form(spelled, VALUE))].length > 0]).toEqual([spelled, true])
        }
      }
    })
  }

  test('a hit is the rule name, never the text', () => {
    const findings = [...scrubFindings(`password=${VALUE}`)]
    expect(findings).toEqual(['credential-field'])
  })

  test('a hit in the middle of a long text, on any line, is found', () => {
    expect(scrubFindings(`line one\nline two\n  "token": "${VALUE}",\nline four`).has('credential-field')).toBe(true)
  })

  test('the scanner rules still apply: a key-shaped string, an email address and a header', () => {
    expect(scrubFindings(['sk', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('-')).size).toBeGreaterThan(0)
    expect(scrubFindings(['someone', 'corp-mail.com'].join('@')).has('email')).toBe(true)
    expect(scrubFindings(['x-api', '-key: abcdefgh12345678'].join('')).size).toBeGreaterThan(0)
  })

  const quiet = [
    'the password and the token',
    'max_tokens: 4096',
    'tokens=12',
    'author: a colleague',
    'authored by someone',
    'password: <redacted>',
    'password: [REDACTED]',
    'token=$TOKEN',
    'token="${TOKEN}"',
    'secret: {{ secret }}',
    'PWD=/work/app',
    'pwd=/home/me',
    'pwd=~/work',
    'cookie:',
    'auth: ',
    'token:\n',
    'passed: 3',
    'password = ',
    'a nice sentence about authorization, cookies and secrets',
  ]
  for (const text of quiet) {
    test(`no finding in ${JSON.stringify(text)}`, () => {
      expect([...scrubFindings(text)].filter((rule) => rule !== 'home-path')).toEqual([])
    })
  }

  test('a home path is never a finding on its own, as before', () => {
    expect(scrubFindings('/Users/someone/work').has('home-path')).toBe(false)
  })
})

describe('scrubFindings: a real value is not taken for a placeholder', () => {
  // Assembled at runtime so this file holds no credential-shaped literal.
  const REAL = [
    ['$', 'uperSecret42'].join(''),
    ['${', 'uperSecret42}'].join(''),
    ['<', 'uperSecret42'].join(''),
    ['<', 'uper Secret 42>'].join(''),
    ['[', 'uperSecret42]'].join(''),
    ['{', 'uperSecret42}'].join(''),
  ]
  const forms: [string, (value: string) => string][] = [
    ['double-quoted', (v) => `password="${v}"`],
    ['single-quoted', (v) => `password='${v}'`],
    ['unquoted', (v) => `password=${v}`],
    ['with a colon', (v) => `password: ${v}`],
    ['quoted JSON', (v) => `{"password": "${v}"}`],
  ]
  for (const [formName, form] of forms) {
    test(`a value that starts with $, <, [ or { is a finding when ${formName}`, () => {
      for (const value of REAL) expect([value, scrubFindings(form(value)).has('credential-field')]).toEqual([value, true])
    })
  }

  const PLACEHOLDERS = ['${TOKEN}', '$TOKEN', '$DB_PASSWORD', '<placeholder>', '<redacted>', '<abs-path>', '<method>', '[REDACTED]', '[MASKED_VALUE]', '[WITHHELD SECRET]', '***', SCRUB_PLACEHOLDER, EMAIL_PLACEHOLDER]
  for (const [formName, form] of forms) {
    test(`a whole placeholder value is no finding when ${formName}`, () => {
      for (const value of PLACEHOLDERS) expect([value, [...scrubFindings(form(value))].filter((rule) => rule !== 'home-path')]).toEqual([value, []])
    })
  }

  test('a placeholder is exempt only as the whole value: a longer value that starts like one is a finding', () => {
    for (const value of ['$TOKEN_and_more_text', '<redacted> plus a real one', '[REDACTED]x', '***abc', '${TOKEN}tail', '<a b>']) {
      expect([value, scrubFindings(`password="${value}"`).has('credential-field')]).toEqual([value, true])
    }
  })

  test('lowercase names after $ are a finding: a variable reference is upper case, a password is not', () => {
    expect(scrubFindings(`password="${['$', 'uperSecret42'].join('')}"`).has('credential-field')).toBe(true)
    expect(scrubFindings('password="$TOKEN"').has('credential-field')).toBe(false)
  })
})

describe('scrubFindings: JSON text that was escaped by a second JSON layer', () => {
  const VALUE = ['v4lue', 'Of', 'Some', 'Length'].join('')

  test('an escaped quoted field is found, at any depth of escaping', () => {
    expect(scrubFindings(`{"content":"{\\"password\\":\\"${VALUE}\\"}"}`).has('credential-field')).toBe(true)
    expect(scrubFindings(`{"a":"{\\"b\\":\\"{\\\\\\"token\\\\\\":\\\\\\"${VALUE}\\\\\\"}\\"}"}`).has('credential-field')).toBe(true)
    expect(scrubFindings(`[tool] write {"content":"{\\"Authorization\\": \\"Bearer ${VALUE}\\"}"}`).has('credential-field')).toBe(true)
  })

  test('an escaped placeholder, and escaped text with no credential field, are no finding', () => {
    expect(scrubFindings('{"content":"{\\"password\\":\\"${TOKEN}\\"}"}').size).toBe(0)
    expect(scrubFindings('{"content":"{\\"name\\":\\"value\\"}"}').size).toBe(0)
  })
})

describe('redactAbsolutePaths', () => {
  const cases: [string, string][] = [
    ['/tmp/x/y', PATH_PLACEHOLDER],
    ['/Volumes/w/z', PATH_PLACEHOLDER],
    ['/home/other/a', PATH_PLACEHOLDER],
    ['/Users/other/work/app/a.ts', PATH_PLACEHOLDER],
    ['~/notes/a.md', PATH_PLACEHOLDER],
    ['C:\\Users\\x', PATH_PLACEHOLDER],
    ['D:/proj/src/a.ts', PATH_PLACEHOLDER],
    ['"C:\\\\Users\\\\x\\\\p"', `"${PATH_PLACEHOLDER}"`],
    ['open /tmp/x/y now', `open ${PATH_PLACEHOLDER} now`],
    ['(see /tmp/x/y), then', `(see ${PATH_PLACEHOLDER}), then`],
    ['--out=/tmp/x/y', `--out=${PATH_PLACEHOLDER}`],
    ['<path>/srv/a/b</path>', `<path>${PATH_PLACEHOLDER}</path>`],
    ['/a/b.ts:12:3', `${PATH_PLACEHOLDER}:12:3`],
    ['one /a/b and two /c/d', `one ${PATH_PLACEHOLDER} and two ${PATH_PLACEHOLDER}`],
    ['/tmp//x/y', PATH_PLACEHOLDER],
    ['//server/share/x', PATH_PLACEHOLDER],
  ]
  for (const [input, expected] of cases) {
    test(`redacts in ${JSON.stringify(input)}`, () => {
      expect(redactAbsolutePaths(input)).toBe(expected)
    })
  }

  const kept = [
    'https://host/a/b',
    'http://localhost:3000/api/v1/items',
    'ssh://host/owner/repo.git',
    'src/lib/util.ts',
    './src/lib/util.ts',
    '../src/lib/util.ts',
    '<home>/work/app/a.ts',
    '<ws>/src/a.ts',
    '<pkg>/lib/a.js',
    '<cache>/x/y',
    '/tmp',
    '/',
    'and/or',
    's/foo/bar/g',
    '12/31/2026',
    'a / b / c',
    '</div>',
    'file:///not/handled/here',
  ]
  for (const text of kept) {
    test(`keeps ${JSON.stringify(text)}`, () => {
      expect(redactAbsolutePaths(text)).toBe(text)
    })
  }
})

describe('the scrub rules on long text', () => {
  test('a very long path-like or key-like text is handled in linear time and gives the same answer', () => {
    const started = performance.now()
    expect(redactAbsolutePaths(`/${'a'.repeat(200_000)}`)).toBe(`/${'a'.repeat(200_000)}`)
    expect(redactAbsolutePaths('/'.repeat(100_000))).toBe('/'.repeat(100_000))
    expect(redactAbsolutePaths('/a'.repeat(50_000))).toBe(PATH_PLACEHOLDER)
    expect(scrubFindings(`${'token '.repeat(50_000)}`).size).toBe(0)
    expect(scrubFindings(`${'password:\n'.repeat(20_000)}`).size).toBe(0)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
