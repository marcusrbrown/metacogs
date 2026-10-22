/**
 * `<run-dir>/judge.json`: what the judge said for one run, kept for human review.
 *
 * Local artifact only (`evals/runs/` is gitignored, held-out runs live under the state
 * root). It holds judge quotes, so it is never report material: the allowlist reports
 * read counts from the manifest and never open this file. The manifest references it by
 * hash under `artifacts["judge.json"]`.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ArtifactRef, JudgeEvidence } from './manifest'
import { sha256 } from './workspace'

export interface JudgeRecord {
  /** Hash of the redacted task, answer, and record the judge was given; `null` if redaction failed before a request. */
  redacted_input_sha256: string | null
  model_pinned: string
  model_returned: string[]
  criteria: { id: string; verdict: 'pass' | 'fail'; quotes: string[] }[]
  attempts: number
  /** Why the verdict is `judge_error`; absent on a clean verdict. */
  error?: string
}

/** A judge quote may join fragments with `...`; one entry per fragment, or the whole quote when there is no separator. */
export function quoteFragments(quote: string): string[] {
  const parts = quote
    .split(/\.\.\.|\u2026/)
    .map((p) => p.trim())
    .filter(Boolean)
  return parts.length ? parts : [quote.trim()]
}

export function judgeRecordOf(evidence: JudgeEvidence): JudgeRecord {
  return {
    redacted_input_sha256: evidence.redacted_input_sha256 ?? null,
    model_pinned: evidence.model.pinned,
    model_returned: evidence.model.returned,
    criteria: evidence.criteria.map((c) => ({ id: c.id, verdict: c.verdict, quotes: quoteFragments(c.quote) })),
    attempts: evidence.attempts,
    ...(evidence.error_code ? { error: evidence.error_code } : {}),
  }
}

/** Writes `judge.json` (0600) and returns the reference a manifest records. */
export function writeJudgeRecord(runDir: string, evidence: JudgeEvidence): ArtifactRef {
  const text = `${JSON.stringify(judgeRecordOf(evidence), null, 2)}\n`
  writeFileSync(join(runDir, 'judge.json'), text, { mode: 0o600 })
  return { file: 'judge.json', sha256: sha256(text), bytes: Buffer.byteLength(text) }
}

export function readJudgeRecord(text: string): JudgeRecord {
  return JSON.parse(text) as JudgeRecord
}
