export interface ChangelogSection {
  /** Text under the `## <version>` heading, up to the next `## ` heading or the end of the file. Trimmed. */
  body: string
  /** True when the version carries a prerelease suffix (`1.0.0-beta.1`). */
  prerelease: boolean
}

export function isPrerelease(version: string): boolean {
  return version.includes('-')
}

/** The `## <version>` section of a Changesets-style CHANGELOG, or `null` when the file has none for this version. */
export function extractChangelogSection(changelog: string, version: string): ChangelogSection | null {
  const lines = changelog.split(/\r\n|\r|\n/)
  const start = lines.findIndex((line) => line.trimEnd() === `## ${version}`)
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
  return { body, prerelease: isPrerelease(version) }
}
