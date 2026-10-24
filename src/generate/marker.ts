// The helper-version marker line in a generated helper's banner. No Bun imports: the runner reads it too.
export const BANNER_LINE = '// generated — do not edit; run `bun run generate`'

const MARKER_PREFIX = '// helper_version: '

/** Banner of a generated helper: line 1 is the do-not-edit notice, line 2 the stamped version. */
export function helperBanner(version: string): string {
  if (!/^[^\s]+$/.test(version)) throw new Error(`helper version must be a single token without whitespace: ${JSON.stringify(version)}`)
  return `${BANNER_LINE}\n${MARKER_PREFIX}${version}`
}

/** The version in a generated helper's banner marker, or `null` if the bundle does not start with one. */
export function readHelperVersion(bundle: string): string | null {
  const [first, second] = bundle.split('\n', 2)
  if (first !== BANNER_LINE || second === undefined || !second.startsWith(MARKER_PREFIX)) return null
  const version = second.slice(MARKER_PREFIX.length)
  return /^[^\s]+$/.test(version) ? version : null
}
