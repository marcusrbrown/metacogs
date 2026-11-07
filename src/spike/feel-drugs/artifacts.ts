/** Run evidence: leak-scan everything first, then write it at mode 0600. Nothing here ever deletes. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { CredentialLeakError, type Needle, scanForLeaks } from '../../runner/manifest'

export interface EvidenceInput {
  dir: string
  /** Names the run in a leak error. */
  runId: string
  /** File name to text. */
  artifacts: Readonly<Record<string, string>>
  /** The record, written last so a directory holding it is complete. */
  manifestFile: string
  manifest: string
  needles: readonly Needle[]
  /** Extra directories to scan for the needles (a run's workspace). */
  scanDirs?: readonly string[]
  /** Refuse to replace a file that exists (`wx`). Default false. */
  exclusive?: boolean
}

/** Throws `CredentialLeakError` before any byte is written when a needle shows up anywhere. */
export function writeEvidence(input: EvidenceInput): void {
  const findings = scanForLeaks({ needles: input.needles, manifestJson: input.manifest, artifacts: input.artifacts, dirs: input.scanDirs ?? [] })
  if (findings.length > 0) throw new CredentialLeakError(input.runId, [...new Set(findings.map((f) => f.label))])
  const flag = input.exclusive ? 'wx' : 'w'
  mkdirSync(input.dir, { recursive: true, mode: 0o700 })
  for (const [file, text] of Object.entries(input.artifacts)) writeFileSync(join(input.dir, file), text, { mode: 0o600, flag })
  writeFileSync(join(input.dir, input.manifestFile), input.manifest, { mode: 0o600, flag })
}
