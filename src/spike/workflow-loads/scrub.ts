/**
 * What the hidden view and the labeler's pre-send check treat as a secret or a local path. One list serves both, so the check
 * before a request cannot be weaker than the scrub that built the text.
 *
 * - `scrubFindings` is the secret scanner's stricter rule set plus one rule for credential keys: a credential key name next to an
 *   assignment (`password=…`, `"token": …`, `Authorization: …`). The rule never reads the value, so a value that is a placeholder,
 *   a list, an object or empty is withheld like any other, and nothing after a placeholder can slip through behind it. A key name
 *   with no assignment next to it (`the token expired`) is prose and is kept. The cost: `token: ${GH_TOKEN}` is withheld too.
 * - The rules run on the text and on every layer of JSON inside it: a string that parses as a JSON string, object or array is
 *   decoded, and each string value inside is checked again, within fixed limits (`SCRUB_LIMITS`). A limit that is reached is a
 *   finding of its own (`SCRUB_LIMIT_RULE`): what could not be inspected is not trusted.
 * - `inputHoldsSecret` walks a structured tool input the same way, and also takes any object key that is a credential key name as a
 *   finding, whatever the value under it.
 * - `redactAbsolutePaths` replaces every absolute path, not only those under the current home.
 *
 * The scanner itself (`src/scan/secrets.ts`) is not changed: its rules guard committed files, and these guard session text.
 */
import { scanText } from '../../scan/secrets'

/** What an absolute path becomes. */
export const PATH_PLACEHOLDER = '<abs-path>'
/** What a text with a secret finding becomes in the view. */
export const SCRUB_PLACEHOLDER = '[withheld: secret pattern found]'
/** What each email address becomes when an address is a text's only finding. */
export const EMAIL_PLACEHOLDER = '[email]'
/** The rule name a credential key next to an assignment reports under. */
export const CREDENTIAL_FIELD_RULE = 'credential-field'
/** The rule name a reached limit reports under. */
export const SCRUB_LIMIT_RULE = 'scrub-limit'
/**
 * The rule name for an email address that appears only in an unescaped or decoded form of a text (`someone\u0040host.example`), not
 * written out in it. It cannot be replaced in place, so the whole text is withheld; an address written out is the ordinary `email` finding.
 */
export const EMAIL_ENCODED_RULE = 'email-encoded'
/** The scanner's address shape. The scanner reports lines, not positions, so addresses are found with this pattern. */
export const EMAIL_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g

// ── credential keys ────────────────────────────────────────────────────────

/** Names that mark a field as a credential. As the end of a longer name (`db_password`, `X_AUTH_TOKEN`) they count too. */
const CREDENTIAL_KEY = '(?:pass(?:word|wd|phrase)|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth(?:orization)?|cookie)'

/** The most separators (quotes, brackets, backslashes, whitespace, or the two-character escapes `\t` `\n` `\r`) allowed between a key and its `:` or `=`. */
export const MAX_SEPARATORS = 16
/** One separator: a run of backslashes ending in `t`, `n` or `r` is one (an escaped tab, at any depth of escaping), or one quote, bracket, backslash or whitespace character. */
const SEPARATOR = /(?:\\+[tnr]|[\s"'`\\[\]{}()])/.source
/** A credential key, then a short run of separators, then an assignment. Not global, so `test` keeps no state. */
const CREDENTIAL_ASSIGNMENT = new RegExp(`${CREDENTIAL_KEY}${SEPARATOR}{0,${MAX_SEPARATORS}}[:=]`, 'i')
/** An object key that is a credential name, with at most quotes and spaces around it. */
const CREDENTIAL_KEY_NAME = new RegExp(`${CREDENTIAL_KEY}[\\s"']*$`, 'i')

// ── limits ─────────────────────────────────────────────────────────────────

/**
 * What the inspection of one text, or one structured input, may spend. `decodeDepth`: JSON layers decoded one inside another.
 * `containerDepth`: arrays and objects inside one another. `nodes`: values visited. `chars`: the total length of decoded text
 * (the first text is not counted), and also the longest text that is inspected at all. The limits are a parameter so a test can use
 * small ones.
 */
export const SCRUB_LIMITS = { decodeDepth: 8, containerDepth: 64, nodes: 25_000, chars: 2_000_000 }
export type ScrubLimits = typeof SCRUB_LIMITS

interface Walk {
  limits: ScrubLimits
  rules: Set<string>
  /** The addresses written out in the text being inspected: an address found only in another form of it is not among them. */
  written: Set<string>
  nodes: number
  chars: number
  limit: boolean
}

const newWalk = (limits: ScrubLimits): Walk => ({ limits, rules: new Set(), written: new Set(), nodes: 0, chars: 0, limit: false })

/** A text that could be a JSON string, object or array. */
const looksLikeJson = (text: string): boolean => {
  const first = text.trimStart()[0]
  return first === '"' || first === '{' || first === '['
}

function decodeJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return undefined
  }
}

// ── escapes ────────────────────────────────────────────────────────────────

/**
 * `\uXXXX`, `\xXX` and `\/` with any number of backslashes before them (an escape inside an escaped string has more). The lookbehind
 * starts a match only at the first backslash of a run, so a long run of backslashes costs one pass over it, not one per position.
 * A surrogate pair is two escapes, and two `fromCharCode` units are the pair.
 */
const ESCAPE = /(?<!\\)\\+(?:u([0-9a-f]{4})|x([0-9a-f]{2})|(\/))/gi

/** One pass: every such escape replaced by the character it names. A backslash that an escape names stays for the next pass. */
export function unescapeText(text: string): string {
  if (!text.includes('\\')) return text
  return text.replace(ESCAPE, (_, unicode: string | undefined, hex: string | undefined, slash: string | undefined) => (slash ? '/' : String.fromCharCode(Number.parseInt(unicode ?? hex ?? '0', 16))))
}

/**
 * Runs every rule on one form of a text. The scanner's email finding stands for a form that is the text as written (`raw`). In any
 * other form (unescaped, or decoded from JSON) each address is looked up among those written out: one that is not there cannot be
 * replaced in the text, so it is its own finding and the whole text is withheld.
 */
function runRules(text: string, raw: boolean, walk: Walk): void {
  let email = false
  for (const finding of scanText('view', text, 'fixture')) {
    if (finding.rule === 'email') email = true
    else walk.rules.add(finding.rule)
  }
  if (CREDENTIAL_ASSIGNMENT.test(text)) walk.rules.add(CREDENTIAL_FIELD_RULE)
  if (!email) return
  if (raw) {
    walk.rules.add('email')
    for (const address of text.match(EMAIL_ADDRESS) ?? []) walk.written.add(address)
  } else if ((text.match(EMAIL_ADDRESS) ?? []).some((address) => !walk.written.has(address))) walk.rules.add(EMAIL_ENCODED_RULE)
}

/** Runs the rules on one text, then on its unescaped forms, then on whatever JSON it decodes to. `layer` counts the decodes so far. */
function inspectText(text: string, layer: number, walk: Walk): void {
  if (walk.limit) return
  walk.nodes += 1
  if (layer > 0) walk.chars += text.length
  // checked before anything is run on the text: the scanner's time grows with the square of a line's length
  if (walk.nodes > walk.limits.nodes || walk.chars > walk.limits.chars || text.length > walk.limits.chars) {
    walk.limit = true
    return
  }
  runRules(text, layer === 0, walk)
  // JSON parsing cannot be relied on to expose an escaped key (a duplicate property overwrites it, a fence or a label hides the
  // object), so the text is also read with every escape replaced, until nothing changes
  let form = text
  for (let pass = 0; ; pass++) {
    const next = unescapeText(form)
    if (next === form) break
    walk.chars += next.length
    if (pass >= walk.limits.decodeDepth || walk.chars > walk.limits.chars) {
      walk.limit = true
      return
    }
    form = next
    runRules(form, false, walk)
  }
  const whole = looksLikeJson(text) ? decodeJson(text) : undefined
  if (whole) return decodeInto(whole.value, layer, walk)
  // a rendered line such as `[tool] write {"a":…}` or `[output] {…}` holds JSON after a label: the first `{` of each line to its end
  if (!text.includes('{')) return
  for (const line of text.split('\n')) {
    const at = line.indexOf('{')
    if (at < 0) continue
    const embedded = decodeJson(line.slice(at))
    if (embedded) decodeInto(embedded.value, layer, walk)
    if (walk.limit) return
  }
}

/** The value one more JSON layer down, unless the layers are used up. */
function decodeInto(value: unknown, layer: number, walk: Walk): void {
  if (layer >= walk.limits.decodeDepth) {
    walk.limit = true
    return
  }
  inspectValue(value, layer + 1, 0, walk)
}

/** Walks a value: every string through `inspectText`, every object key that names a credential as a finding. */
function inspectValue(value: unknown, layer: number, container: number, walk: Walk): void {
  if (walk.limit) return
  if (typeof value === 'string') return inspectText(value, layer, walk)
  walk.nodes += 1
  if (walk.nodes > walk.limits.nodes) {
    walk.limit = true
    return
  }
  if (typeof value !== 'object' || value === null) return
  if (container >= walk.limits.containerDepth) {
    walk.limit = true
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) inspectValue(entry, layer, container + 1, walk)
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    if (CREDENTIAL_KEY_NAME.test(key) || CREDENTIAL_ASSIGNMENT.test(key)) walk.rules.add(CREDENTIAL_FIELD_RULE)
    inspectValue(entry, layer, container + 1, walk)
  }
}

const findingsOf = (walk: Walk): Set<string> => {
  const rules = new Set(walk.rules)
  rules.delete('home-path')
  if (walk.limit) rules.add(SCRUB_LIMIT_RULE)
  return rules
}

/**
 * Whether a structured tool input holds a secret, found before the input is serialized: serializing escapes the quotes, tabs and
 * newlines of any text held in a string. Every string is checked as the text it is, with the JSON layers inside it; any object key
 * that is a credential name counts whatever its value; a limit that is reached counts. An email address alone is not a secret here.
 */
export function inputHoldsSecret(input: unknown, limits: ScrubLimits = SCRUB_LIMITS): boolean {
  const walk = newWalk(limits)
  inspectValue(input, 0, 0, walk)
  return [...findingsOf(walk)].some((rule) => rule !== 'email' && rule !== EMAIL_ENCODED_RULE)
}

/**
 * The names of the rules that fire on a text, other than a home path (path redaction handles that one without losing the text).
 * Never the matched text.
 */
export function scrubFindings(text: string, limits: ScrubLimits = SCRUB_LIMITS): Set<string> {
  const walk = newWalk(limits)
  inspectText(text, 0, walk)
  return findingsOf(walk)
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
