import { describe, expect, test } from 'bun:test'

import { inputHoldsSecret, MAX_SEPARATORS, PATH_PLACEHOLDER, redactAbsolutePaths, SCAN_WINDOW, SCRUB_LIMITS, SCRUB_LIMIT_RULE, type ScrubLimits, scrubFindings, unescapeText } from './scrub'
import { CREDENTIAL_TEXT_CASES, EMAIL_TEXT_CASES } from './scrub-cases'

// Assembled at runtime so this file holds no credential-shaped literal.
/** The default limits without the bounds on length, for the tests of how the rules scale. */
const UNBOUNDED: ScrubLimits = { ...SCRUB_LIMITS, line: Number.POSITIVE_INFINITY, chars: Number.POSITIVE_INFINITY }

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

  // a key name with no assignment next to it is prose
  const quiet = [
    'the password and the token',
    'the token expired',
    'rotate the password',
    'max_tokens: 4096',
    'tokens=12',
    'author: a colleague',
    'authored by someone',
    'passed: 3',
    'password reset email sent',
    'a nice sentence about authorization, cookies and secrets',
    'token (see below) and secret (see above)',
  ]
  for (const text of quiet) {
    test(`no finding in ${JSON.stringify(text)}`, () => {
      expect([...scrubFindings(text)].filter((rule) => rule !== 'home-path')).toEqual([])
    })
  }

  // no value is inspected: an empty value, a placeholder and a path are withheld like any other
  const assigned = ['password: <redacted>', 'password: [REDACTED]', 'token=$TOKEN', 'token: ${GH_TOKEN}', 'token="${TOKEN}"', 'secret: {{ secret }}', 'PWD=/work/app', 'pwd=/home/me', 'pwd=~/work', 'cookie:', 'auth: ', 'token:\n', 'password = ', 'password=***', 'password="[email]"']
  for (const text of assigned) {
    test(`a finding in ${JSON.stringify(text)}, whatever the value`, () => {
      expect(scrubFindings(text).has('credential-field')).toBe(true)
    })
  }

  test('a home path is never a finding on its own, as before', () => {
    expect(scrubFindings('/Users/someone/work').has('home-path')).toBe(false)
  })
})

describe('scrubFindings: the key next to an assignment', () => {
  // Assembled at runtime so this file holds no credential-shaped literal.
  const V = ['harbor', 'Moon42'].join('')
  const hit = (text: string): boolean => scrubFindings(text).has('credential-field')

  test('separators between the key and the assignment: quotes, brackets, backslashes, spaces, tabs and the escapes \\t \\n \\r \\"', () => {
    const forms = [
      `password=${V}`,
      `password : ${V}`,
      `"password":"${V}"`,
      `password\t=\t${V}`,
      `password\\t=\\t${V}`,
      `password\\\\\\t= ${V}`,
      `password\n=${V}`,
      `password\r\n: ${V}`,
      `\\"password\\":\\"${V}\\"`,
      `[password]=${V}`,
      `password[]=${V}`,
      `{password:["${V}"]}`,
      `(token)=${V}`,
      `password\t\t  \t=${V}`,
    ]
    for (const form of forms) expect([form, hit(form)]).toEqual([form, true])
  })

  test('the run of separators is short: the limit is exact', () => {
    expect(hit(`password${' '.repeat(MAX_SEPARATORS)}=${V}`)).toBe(true)
    expect(hit(`password${' '.repeat(MAX_SEPARATORS + 1)}=${V}`)).toBe(false)
  })

  test('a word character between the key and the assignment ends the match', () => {
    for (const text of ['password_x=1', 'passwords=1', 'token2: a', 'tokenize: yes', 'secretary: Jo']) expect([text, hit(text)]).toEqual([text, false])
  })

  test('a placeholder prefix does not exempt the value after it', () => {
    for (const text of [`password="[email]${V}"`, `password=[REDACTED]${V}`, `password="[withheld: secret pattern found]${V}"`, `password=<redacted>${V}`, `password=\${TOKEN}${V}`]) expect([text, hit(text)]).toEqual([text, true])
  })

  test('JSON text is decoded: a key written with unicode escapes is found, and so is one inside a string inside a string', () => {
    expect(hit(JSON.stringify({ ['\u0070assword']: V }).replace('"password"', '"\\u0070assword"'))).toBe(true)
    expect(hit(JSON.stringify({ payload: JSON.stringify({ body: JSON.stringify({ ['pass' + 'word']: [V] }) }) }))).toBe(true)
    expect(hit(JSON.stringify(JSON.stringify({ body: `password\t=\t${V}` })))).toBe(true)
  })

  test('JSON after a label on a rendered line is decoded too: the first brace of each line to its end', () => {
    expect(hit(`### [stimulus] a1\n[tool] write ${JSON.stringify({ ['\u0070assword']: [V] }).replace('"password"', '"\\u0070assword"')}`)).toBe(true)
    expect(hit(`[tool] bash (error) {"command":"ls"}\n[output] {"a":{"${['to', 'ken'].join('')}":[1]}}`)).toBe(true)
    expect(hit('[tool] bash {"command":"ls"}\n[output] fine {"a":1} and more')).toBe(false)
  })

  test('a credential key in a decoded object is a finding whatever its value is', () => {
    for (const value of [`["${V}"]`, `{"value":"${V}"}`, '"x"', '5', 'true', 'null', '[]', '{}']) {
      const text = JSON.stringify({ ['api' + '_key']: JSON.parse(value) })
      expect([text, hit(text)]).toEqual([text, true])
    }
    // the same key as a plain word, with no assignment, is not
    expect(hit(JSON.stringify({ note: 'the token expired', max_tokens: 5 }))).toBe(false)
  })

  // small limits keep these cheap: the scanner's time grows with the square of a line's length
  const SMALL: ScrubLimits = { decodeDepth: 3, containerDepth: 5, nodes: 20, chars: 500, line: 500 }
  const limited = (text: string): boolean => scrubFindings(text, SMALL).has(SCRUB_LIMIT_RULE)

  test('a limit hit is a finding of its own: layers, containers, nodes, decoded size and a text too long to inspect', () => {
    const wrap = (n: number): string => {
      let text = 'leaf'
      for (let i = 0; i < n; i++) text = JSON.stringify({ body: text })
      return text
    }
    const nest = (n: number): unknown => {
      let value: unknown = 'leaf'
      for (let i = 0; i < n; i++) value = [value]
      return value
    }
    expect(limited(wrap(SMALL.decodeDepth + 1))).toBe(true)
    expect(limited(wrap(SMALL.decodeDepth))).toBe(false)
    expect(limited(JSON.stringify(nest(SMALL.containerDepth + 1)))).toBe(true)
    expect(limited(JSON.stringify(nest(SMALL.containerDepth)))).toBe(false)
    expect(limited(JSON.stringify(Array.from({ length: SMALL.nodes + 1 }, () => 0)))).toBe(true)
    expect(limited(JSON.stringify(Array.from({ length: SMALL.nodes - 3 }, () => 0)))).toBe(false)
    // two decoded layers whose sizes add up past the limit, each under it
    const half = 'y'.repeat(Math.floor(SMALL.chars / 2) + 10)
    expect(limited(JSON.stringify({ a: JSON.stringify({ b: half }) }))).toBe(true)
    expect(limited(JSON.stringify({ a: half }))).toBe(false)
    // a plain text over the size limit is not inspected, so it is not trusted
    expect(limited('z'.repeat(SMALL.chars + 1))).toBe(true)
    expect(limited('z'.repeat(SMALL.chars))).toBe(false)
  })

  test('a limit hit has no effect on text under the limits, and the limits in force are the documented ones', () => {
    let ok = 'leaf'
    for (let i = 0; i < 4; i++) ok = JSON.stringify({ body: ok })
    expect(scrubFindings(ok).size).toBe(0)
    expect(SCRUB_LIMITS).toEqual({ decodeDepth: 8, containerDepth: 64, nodes: 25_000, chars: 1_000_000, line: 20_000 })
    expect(scrubFindings('x'.repeat(SCRUB_LIMITS.chars + 1)).has(SCRUB_LIMIT_RULE)).toBe(true)
  })
})

describe('scrubFindings: text written with escapes', () => {
  // Assembled at runtime so this file holds no credential-shaped literal.
  const V = ['harbor', 'Moon42'].join('')
  const hit = (text: string): boolean => scrubFindings(text).has('credential-field')
  const encode = (text: string): string => text.replace(/\\/g, '\\u005c')

  test('unescapeText names the character of \\uXXXX (any number of backslashes, any case, a surrogate pair), \\xXX and \\/', () => {
    expect(unescapeText('\\u0070 \\\\u0070 \\\\\\\\\\u0070 \\u004F \\u004f')).toBe('p p p O O')
    expect(unescapeText('\\ud83d\\ude00 and \\uD83D\\uDE00')).toBe('\u{1f600} and \u{1f600}')
    expect(unescapeText('\\x41\\x4a \\x4')).toBe('AJ \\x4')
    expect(unescapeText('a\\/b \\\\/c')).toBe('a/b /c')
    expect(unescapeText('no escapes \\d \\w \\u12 \\xZ here')).toBe('no escapes \\d \\w \\u12 \\xZ here')
    expect(unescapeText('')).toBe('')
  })

  test('a credential key written with an escape is found, in the forms JSON parsing cannot reach', () => {
    for (const text of [`\\u0070assword=${V}`, `pass\\x77ord: ${V}`, `{"body":{"\\u0070assword":"${V}"},"body":null}`, `prose\\n\`\`\`json\\n{\\n "\\u0070assword": "${V}"\\n}\\n\`\`\``, `[tool] read [{"\\\\u0070assword":"${V}"}]`, `to\\u006ben=${V}`]) {
      expect([text, hit(text)]).toEqual([text, true])
    }
  })

  test('every text of the shared table is a finding', () => {
    for (const text of CREDENTIAL_TEXT_CASES) expect([text, scrubFindings(text).size > 0]).toEqual([text, true])
  })

  test('every short JSON escape is replaced, with any number of backslashes before it', () => {
    expect(unescapeText('a\\nb \\\\nc \\\\\\\\td')).toBe('a\nb \nc \td')
    expect(unescapeText('\\b\\f\\r')).toBe('\b\f\r')
    expect(unescapeText('say \\"hi\\" and \\\\"hi\\\\"')).toBe('say "hi" and "hi"')
    // a run of two or more backslashes with no escape after it is one backslash; a single one stays
    expect(unescapeText('C:\\\\Users \\\\\\\\ and \\d')).toBe('C:\\Users \\ and \\d')
  })

  test('a run of backslashes and then any ASCII letter separates a key from its assignment', () => {
    for (const letter of ['b', 'f', 'v', 'a', 'q', 'T', 'Z']) {
      for (const run of ['\\', '\\\\', '\\\\\\']) {
        const text = `password${run}${letter}=${V}`
        expect([text, hit(text)]).toEqual([text, true])
      }
    }
    // control characters, as the unescaped forms hold them, separate too
    expect(hit(`password\f=${V}`)).toBe(true)
    expect(hit(`password\b:${V}`)).toBe(true)
  })

  test('unescaping repeats until nothing changes: an escape of the backslash of another escape', () => {
    const once = '\\u0070assword=x'
    expect(hit(encode(once))).toBe(true)
    expect(hit(encode(encode(once)))).toBe(true)
    expect(hit(encode(encode(encode(encode(once)))))).toBe(true)
  })

  test('the passes are limited: a text that still changes after the last pass is a finding of its own', () => {
    const small: ScrubLimits = { decodeDepth: 3, containerDepth: 5, nodes: 20, chars: 500, line: 500 }
    let text = '\\u0070lain'
    // `\u0070lain` is one pass, and each encoding adds one
    for (let i = 0; i < 2; i++) text = encode(text)
    expect(scrubFindings(text, small).has(SCRUB_LIMIT_RULE)).toBe(false)
    expect(scrubFindings(encode(text), small).has(SCRUB_LIMIT_RULE)).toBe(true)
  })

  test('the unescaped forms count toward the size limit, though the text itself is under it', () => {
    const limits: ScrubLimits = { decodeDepth: 8, containerDepth: 5, nodes: 100, chars: 150, line: 150 }
    let text = `\\u0070${'a'.repeat(40)}`
    for (let i = 0; i < 3; i++) text = encode(text)
    expect(text.length).toBeLessThanOrEqual(limits.chars)
    expect(scrubFindings(text, limits).has(SCRUB_LIMIT_RULE)).toBe(true)
    expect(scrubFindings(text, { ...limits, chars: 2000 }).has(SCRUB_LIMIT_RULE)).toBe(false)
  })

  test('a known-format secret written with escapes is found', () => {
    const key = ['sk', 'ant', 'abcdefghijklmnopqrstuvwx'].join('-')
    expect(scrubFindings(key).size).toBeGreaterThan(0)
    expect(scrubFindings(key.replaceAll('-', '\\u002d')).size).toBeGreaterThan(0)
  })

  test('an address is the email finding whether it is written out, written with an escape, or both', () => {
    for (const text of EMAIL_TEXT_CASES) expect([text, [...scrubFindings(text)]]).toEqual([text, ['email']])
  })

  test('ordinary escapes name nothing: no finding', () => {
    for (const text of ['caf\\u00e9 and na\\u00efve', 'a\\/b\\/c', '\\x41\\x42', 'a\\tb\\nc']) expect([text, scrubFindings(text).size]).toEqual([text, 0])
  })

  test('long runs of backslashes stay linear', () => {
    const started = performance.now()
    expect(scrubFindings('\\'.repeat(200_000) + 'u0070', UNBOUNDED).size).toBe(0)
    expect(scrubFindings('\\u00'.repeat(30_000), UNBOUNDED).size).toBe(0)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('inputHoldsSecret: escaped text', () => {
  test('an email written with an escape is not a secret here, as a literal one is not: the serialized input decides', () => {
    expect(inputHoldsSecret({ to: 'someone\\u0040corp-mail.com' })).toBe(false)
    expect(inputHoldsSecret({ k: '\\u0070assword=x' })).toBe(true)
  })
})

describe('scrubFindings: the cost of a long line', () => {
  const quickly = (fn: () => unknown, ms = 2000): void => {
    const started = performance.now()
    fn()
    expect(performance.now() - started).toBeLessThan(ms)
  }

  test('a line longer than the line bound is a limit finding, and costs nothing: the scanner is not run on it', () => {
    quickly(() => {
      for (const length of [SCRUB_LIMITS.line + 1, 100_000, 400_000, 2_000_000]) expect([length, scrubFindings('x'.repeat(length)).has(SCRUB_LIMIT_RULE)]).toEqual([length, true])
    })
  })

  test('the bound is per line: many short lines of any total length up to the hard bound are scanned', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line number ${i}`).join('\n')
    expect(lines.length).toBeGreaterThan(SCRUB_LIMITS.line)
    expect(scrubFindings(lines).size).toBe(0)
    expect(scrubFindings(`${lines}\n${'x'.repeat(SCRUB_LIMITS.line + 1)}`).has(SCRUB_LIMIT_RULE)).toBe(true)
    expect(scrubFindings('x'.repeat(SCRUB_LIMITS.line)).has(SCRUB_LIMIT_RULE)).toBe(false)
  })

  test('a text over the hard bound is a limit finding whatever its lines are', () => {
    const lines = 'short line\n'.repeat(Math.ceil(SCRUB_LIMITS.chars / 11) + 1)
    expect(lines.length).toBeGreaterThan(SCRUB_LIMITS.chars)
    quickly(() => expect(scrubFindings(lines).has(SCRUB_LIMIT_RULE)).toBe(true))
  })

  test('a string in a structured input longer than the hard bound is a limit finding, not a prefix scan', () => {
    expect(inputHoldsSecret({ content: 'x'.repeat(SCRUB_LIMITS.chars + 1) })).toBe(true)
    expect(inputHoldsSecret({ content: 'x'.repeat(SCRUB_LIMITS.chars) })).toBe(false)
  })

  test('a string in a structured input is inspected only as far as the window: a secret beyond it is not what the view keeps', () => {
    const key = ['sk', 'ant', 'abcdefghijklmnopqrstuvwx'].join('-')
    const filler = 'ab cd '.repeat(Math.ceil((SCAN_WINDOW + 100) / 6))
    expect(inputHoldsSecret({ content: `${filler}${key}` })).toBe(false)
    expect(inputHoldsSecret({ content: `${filler.slice(0, SCAN_WINDOW - 100)}${key}` })).toBe(true)
  })
})

describe('inputHoldsSecret', () => {
  const V = ['harbor', 'Moon42'].join('')

  test('a credential key holds a secret whatever its value: array, object, string, number, boolean, null, empty', () => {
    for (const value of [[V], { value: V }, V, 12345678, true, null, '', [], {}]) {
      const input = { nested: { ['pass' + 'word']: value } }
      expect([JSON.stringify(input), inputHoldsSecret(input)]).toEqual([JSON.stringify(input), true])
    }
    expect(inputHoldsSecret({ headers: { 'X-AUTH-TOKEN': 'x' } })).toBe(true)
    expect(inputHoldsSecret({ db_password: 'x' })).toBe(true)
  })

  test('a string value is checked as text, in every decoded layer', () => {
    expect(inputHoldsSecret({ content: `password\t=\t${V}` })).toBe(true)
    expect(inputHoldsSecret({ payload: JSON.stringify({ body: `password\t=\t${V}` }) })).toBe(true)
    expect(inputHoldsSecret({ list: [{ a: JSON.stringify({ ['to' + 'ken']: { v: V } }) }] })).toBe(true)
  })

  test('ordinary input is not a secret, and an email address alone is not one here', () => {
    expect(inputHoldsSecret({ filePath: 'a.ts', content: 'the token expired; rotate the password', max_tokens: 5, tags: ['a', 'b'] })).toBe(false)
    expect(inputHoldsSecret({ to: ['someone', 'corp-mail.com'].join('@') })).toBe(false)
    expect(inputHoldsSecret(undefined)).toBe(false)
    expect(inputHoldsSecret(null)).toBe(false)
    expect(inputHoldsSecret(7)).toBe(false)
  })

  test('an input that exceeds a limit is a secret: too deep, or with too many nodes', () => {
    let deep: unknown = 'leaf'
    for (let i = 0; i < SCRUB_LIMITS.containerDepth + 5; i++) deep = { a: deep }
    expect(inputHoldsSecret(deep)).toBe(true)
    expect(inputHoldsSecret(Array.from({ length: SCRUB_LIMITS.nodes + 1 }, () => 'x'))).toBe(true)
    expect(inputHoldsSecret(Array.from({ length: 10 }, () => 'x'), { decodeDepth: 3, containerDepth: 5, nodes: 5, chars: 500, line: 500 })).toBe(true)
  })

  test('a deeply wrapped assignment is a secret, however deep', () => {
    let nested: unknown = `password\t=\t${V}`
    for (let i = 0; i < SCRUB_LIMITS.containerDepth + 40; i++) nested = { body: nested }
    expect(inputHoldsSecret({ content: nested })).toBe(true)
    // layers of JSON strings grow by about half again each time, so the layers the default limit allows are longer than the window
    let wrapped = `password\t=\t${V}`
    for (let i = 0; i < 8; i++) wrapped = JSON.stringify({ body: wrapped })
    expect(inputHoldsSecret({ content: wrapped }, { ...SCRUB_LIMITS, decodeDepth: 3 })).toBe(true)
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
    expect(scrubFindings(`${'token '.repeat(50_000)}`, UNBOUNDED).size).toBe(0)
    expect(scrubFindings(`${'password:\n'.repeat(20_000)}`).has('credential-field')).toBe(true)
    expect(scrubFindings(`${'password '.repeat(50_000)}`, UNBOUNDED).size).toBe(0)
    expect(scrubFindings(`${'\\'.repeat(200_000)}`, UNBOUNDED).size).toBe(0)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
