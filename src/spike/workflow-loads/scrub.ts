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

/** Names that mark the value after them as a credential. As the end of a longer name (`db_password`, `X_AUTH_TOKEN`) they count too. */
const CREDENTIAL_KEY = '(?:pass(?:word|wd|phrase)|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth(?:orization)?|cookie)'
/** A value is quoted (any length, spaces allowed), or a run of at least three characters that is not punctuation or a bracket. */
const CREDENTIAL_VALUE = `(?:"(?![$<\\[{])[^"\\n]+"|'(?![$<\\[{])[^'\\n]+'|(?![$<\\[{"'])[^\\s"'<>,;&|(){}\\[\\]]{3,})`
/** `key=value`, `key: value`, and `"key": "value"`, on one line. Group 1 is the key, group 2 the value. */
const CREDENTIAL_FIELD = new RegExp(`(${CREDENTIAL_KEY})["']?[ \\t]*[:=][ \\t]*(${CREDENTIAL_VALUE})`, 'gi')
/** An unquoted word that says there is no value. */
const LITERAL_VALUE = /^(?:true|false|null|none|nil|undefined)$/i
/** A working directory, which `PWD=…` holds in any shell's environment dump, is no password. */
const PATH_VALUE = /^(?:[/~.]|[A-Za-z]:[\\/])/

function holdsCredentialField(text: string): boolean {
  for (const match of text.matchAll(CREDENTIAL_FIELD)) {
    const [, key = '', value = ''] = match
    const quoted = value.startsWith('"') || value.startsWith("'")
    if (!quoted && LITERAL_VALUE.test(value)) continue
    if (!quoted && /^pwd$/i.test(key) && PATH_VALUE.test(value)) continue
    return true
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
