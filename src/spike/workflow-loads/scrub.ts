/**
 * What the hidden view and the labeler's pre-send check treat as a secret or a local path. One list serves both, so the check
 * before a request cannot be weaker than the scrub that built the text.
 *
 * - `scrubFindings` is the secret scanner's stricter rule set plus a rule for credential fields (`password=…`, `"token": "…"`,
 *   `Authorization: …`, `Cookie: …`), which the scanner leaves alone unless the value is quoted and long.
 * - `redactAbsolutePaths` replaces every absolute path, not only those under the current home.
 *
 * The scanner itself (`src/scan/secrets.ts`) is not changed: its rules guard committed files, and these guard session text.
 */
import { scanText } from '../../scan/secrets'

/** What an absolute path becomes. */
export const PATH_PLACEHOLDER = '<abs-path>'
/** The rule name a credential field reports under. */
export const CREDENTIAL_FIELD_RULE = 'credential-field'

// ── credential fields ──────────────────────────────────────────────────────

/** What a text with a secret finding becomes in the view. */
export const SCRUB_PLACEHOLDER = '[withheld: secret pattern found]'
/** What each email address becomes when an address is a text's only finding. */
export const EMAIL_PLACEHOLDER = '[email]'

/** Names that mark the value after them as a credential. As the end of a longer name (`db_password`, `X_AUTH_TOKEN`) they count too. */
const CREDENTIAL_KEY = '(?:pass(?:word|wd|phrase)|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth(?:orization)?|cookie)'
/**
 * A value: quoted (any length, spaces allowed); or one token that starts with `$`, `<`, `[` or `{` (a placeholder is exempted
 * afterwards, as a whole, by `isPlaceholder`); or a run of at least three characters that is not punctuation or a bracket.
 * `$` comes before the plain run so `$name` is taken whole, and a bracket token stops at a parenthesis so `(token=<x>)` does.
 */
const CREDENTIAL_VALUE = `(?:"[^"\\n]+"|'[^'\\n]+'|\\$(?:\\{[^\\s"',;{}]+\\}|[^\\s"'<>,;&|(){}\\[\\]]{2,})|[<\\[{][^\\s"',;()]{2,}|[^\\s"'<>,;&|(){}\\[\\]]{3,})`
/** `key=value`, `key: value`, and `"key": "value"`, on one line. Group 1 is the key, group 2 the value. */
const CREDENTIAL_FIELD = new RegExp(`(${CREDENTIAL_KEY})["']?[ \\t]*[:=][ \\t]*(${CREDENTIAL_VALUE})`, 'gi')
/** An unquoted word that says there is no value. */
const LITERAL_VALUE = /^(?:true|false|null|none|nil|undefined)$/i
/** A working directory, which `PWD=…` holds in any shell's environment dump, is no password. */
const PATH_VALUE = /^(?:[/~.]|[A-Za-z]:[\\/])/
/** `[REDACTED]`, `[MASKED_VALUE]`, `[WITHHELD SECRET]`: brackets around upper-case words. */
const BRACKETED_CAPS = /^\[[A-Z][A-Z0-9_-]*(?: [A-Z][A-Z0-9_-]*)*\]$/
/** The whole of a value that stands for a secret instead of holding one. Anything longer, or any other shape, is taken for the secret. */
const PLACEHOLDER_VALUES = [
  // an environment variable reference: upper case, digits and underscores, with or without braces
  /^\$[A-Z_][A-Z0-9_]*$/,
  /^\$\{[A-Z_][A-Z0-9_]*\}$/,
  // <placeholder>: angle brackets around one word, no spaces
  /^<[^\s<>]+>$/,
  // [REDACTED], [MASKED_VALUE]: brackets around upper-case words
  BRACKETED_CAPS,
  /^\*{3,}$/,
]
/** The view's own placeholders, which a rendered text may hold after a field name. They may contain spaces, so they are matched as a prefix. */
const OWN_PLACEHOLDERS = [SCRUB_PLACEHOLDER, EMAIL_PLACEHOLDER, PATH_PLACEHOLDER]

/** A whole value with no quotes around it stands for a secret instead of holding one. */
const isPlaceholderText = (bare: string): boolean => PLACEHOLDER_VALUES.some((shape) => shape.test(bare)) || OWN_PLACEHOLDERS.includes(bare)

/** A value as the pattern found it, quotes included, is a placeholder only as a whole. */
function isPlaceholder(value: string): boolean {
  const quoted = value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))
  return isPlaceholderText(quoted ? value.slice(1, -1) : value)
}

/** Whether a field's value, given as the JSON value it is, is a secret: any non-placeholder string, and a longer number or boolean. */
function holdsCredentialValue(value: unknown): boolean {
  if (typeof value === 'string') return value !== '' && !isPlaceholderText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).length >= 3 && !LITERAL_VALUE.test(String(value))
  return false
}

const CREDENTIAL_KEY_END = new RegExp(`${CREDENTIAL_KEY}$`, 'i')

/** One level of JSON escaping of quotes removed, at any depth: `\"` and `\\\"` both become `"`. */
const unescapeQuotes = (text: string): string => text.replace(/\\+(["'])/g, '$1')

function holdsCredentialField(text: string): boolean {
  for (const match of text.matchAll(CREDENTIAL_FIELD)) {
    const [whole = '', key = '', value = ''] = match
    const quoted = value.startsWith('"') || value.startsWith("'")
    if (!quoted && LITERAL_VALUE.test(value)) continue
    if (!quoted && /^pwd$/i.test(key) && PATH_VALUE.test(value)) continue
    if (isPlaceholder(value)) continue
    // a placeholder that holds spaces, which the value pattern stops at: the view's own, or bracketed upper-case words
    const rest = text.slice((match.index ?? 0) + whole.length - value.length)
    if (value.startsWith('[') && BRACKETED_CAPS.test(/^\[[^\]\n]*\]/.exec(rest)?.[0] ?? '')) continue
    if (OWN_PLACEHOLDERS.some((own) => rest.startsWith(own) || rest.startsWith(`"${own}`) || rest.startsWith(`'${own}`))) continue
    return true
  }
  return false
}

const MAX_INPUT_DEPTH = 50

/**
 * Whether a structured tool input holds a secret, found before the input is serialized: serializing escapes the quotes of any
 * JSON text held in a string (`{"password":"x"}` becomes `{\"password\":\"x\"}`), which would hide it from the text rules.
 * Every string value is scanned as the text it is, and every field whose key ends in a credential name is checked as a pair.
 * A scan finding that is only an email address is not a secret here; the serialized text is scanned afterwards as before.
 */
export function inputHoldsSecret(value: unknown, depth = 0): boolean {
  if (depth > MAX_INPUT_DEPTH) return false
  if (typeof value === 'string') return [...scrubFindings(value)].some((rule) => rule !== 'email')
  if (Array.isArray(value)) return value.some((entry) => inputHoldsSecret(entry, depth + 1))
  if (typeof value !== 'object' || value === null) return false
  for (const [key, entry] of Object.entries(value)) {
    if (CREDENTIAL_KEY_END.test(key) && holdsCredentialValue(entry)) return true
    if (inputHoldsSecret(entry, depth + 1)) return true
  }
  return false
}

/**
 * The names of the rules that fire on a text, other than a home path (path redaction handles that one without losing the text).
 * Never the matched text.
 */
export function scrubFindings(text: string): Set<string> {
  const rules = new Set(scanText('view', text, 'fixture').map((finding): string => finding.rule))
  rules.delete('home-path')
  if (holdsCredentialField(text)) rules.add(CREDENTIAL_FIELD_RULE)
  // JSON text inside a JSON string carries its quotes escaped; the rules above need them plain
  const decoded = text.includes('\\') ? unescapeQuotes(text) : text
  if (decoded !== text && holdsCredentialField(decoded)) rules.add(CREDENTIAL_FIELD_RULE)
  return rules
}

// ── absolute paths ─────────────────────────────────────────────────────────

/** What ends a path: whitespace, a quote, a bracket, a list separator, or `:` (which ends `path:line:column`). */
const PATH_END = '\\s"\'`<>()|,;:\\[\\]{}'
/** A segment of a path with `/` separators. Slash-free, so a match is found in one pass and a long path cannot backtrack. */
const SEGMENT = `[^${PATH_END}/]`
/** A path that follows one of the view's own placeholders is already shortened; it is not an absolute path. */
const AFTER_PLACEHOLDER = '(?<!<home>|<ws>|<pkg>|<cache>)'
/** `/a/b…`: at least two segments, not part of a word, a URL, a relative path or a longer path. */
const POSIX_PATH = new RegExp(`(?<![\\w:/.~-])${AFTER_PLACEHOLDER}/+${SEGMENT}+(?:/+${SEGMENT}+)+`, 'g')
const HOME_PATH = new RegExp(`(?<![\\w~])~/[^${PATH_END}]+`, 'g')
/** `C:\\x` or `C:/x`, also as written inside a JSON string (`C:\\\\x`). Backslashes are part of the path here. */
const DRIVE_PATH = new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\/][^${PATH_END}]+`, 'g')

/** Every absolute path in a text becomes `PATH_PLACEHOLDER`. URL paths, relative paths and a lone `/segment` stay. */
export function redactAbsolutePaths(text: string): string {
  return text.replace(DRIVE_PATH, PATH_PLACEHOLDER).replace(HOME_PATH, PATH_PLACEHOLDER).replace(POSIX_PATH, PATH_PLACEHOLDER)
}
