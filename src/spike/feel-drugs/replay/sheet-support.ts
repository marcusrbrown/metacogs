/** Synthetic campaigns, seeded shuffles and sheet filling for the sheet and reveal tests. Synthetic text only. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Rng } from '../blind'
import { ARM_NAMES, type ArmName, REPLAY_MODELS } from './gates'
import type { AttemptJob } from './host'
import { type CampaignOptions, runCampaign } from './run'
import type { KeyAnswer, KeyFixture, SheetKey } from './sheet'
import { approvedFixture, fakeExecutor, stdoutOf, stepFinish, textEvent, toolEvent } from './test-support'
import { openStore, type FixtureSpec, type Store } from './store'

export const OUTCOME_REF = 'UNIQUE-OUTCOME-REF-7731'
export const WORKED = 'Run the checks next.'

export interface SheetLab {
  store: Store
  state: string
  repoRoot: string
  env: Record<string, string | undefined>
  dispose(): void
}

/** A store at the layout the command line opens: `<state>/metacogs/replay`. */
export function newSheetLab(): SheetLab {
  const base = mkdtempSync(join(tmpdir(), 'replay-sheet-'))
  const state = join(base, 'state')
  const repoRoot = join(base, 'repo')
  mkdirSync(repoRoot)
  mkdirSync(state)
  const env = { XDG_STATE_HOME: state }
  const store = openStore({ env, repoRoot, now: () => new Date('2026-11-07T12:00:00.000Z') })
  return { store, state, repoRoot, env, dispose: () => rmSync(base, { recursive: true, force: true }) }
}

/** mulberry32: the same seed gives the same shuffle. */
export function seeded(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export type AnswerPlan = { stdout: string } | 'timeout' | 'excluded'

export interface FixturePlan {
  id: string
  kind: FixtureSpec['kind']
  spec?: Partial<FixtureSpec>
}

export interface CampaignPlan {
  name?: string
  fixtures: FixturePlan[]
  models?: readonly string[]
  arms?: readonly ArmName[]
  /** What the model said for a job. Default: one plain line per arm, with no arm tell. */
  answer?: (job: Pick<AttemptJob, 'fixtureId' | 'model' | 'arm'>) => AnswerPlan | undefined
}

const plain = (arm: string): string => stdoutOf(textEvent(`${WORKED} (${arm})`), stepFinish())

/** Builds approved fixtures and runs a scripted campaign over them with the fake host. */
export async function runSyntheticCampaign(lab: SheetLab, plan: CampaignPlan): Promise<string> {
  const name = plan.name ?? 'phase1'
  for (const f of plan.fixtures) approvedFixture(lab.store, { id: f.id, kind: f.kind, expected_outcome_ref: OUTCOME_REF, ...f.spec })
  const { executor } = fakeExecutor({
    tweak: (job, result) => {
      const planned = plan.answer?.(job)
      if (planned === 'timeout') return { ...result, timedOut: true, exitCode: -1, assistants: null, partTypes: null }
      if (planned === 'excluded') return { ...result, hostVersion: '0.0.0' }
      return { ...result, stdout: planned?.stdout ?? plain(job.arm) }
    },
  })
  const options: CampaignOptions = {
    name,
    models: plan.models ?? [...REPLAY_MODELS],
    arms: plan.arms ?? [...ARM_NAMES],
    fixtures: plan.fixtures.map((f) => f.id),
    capUsd: 1,
    provider: 'scripted',
  }
  await runCampaign(options, { store: lab.store, executor, skillsDir: '/pkg/plugin/skills' })
  return name
}

export { stdoutOf, stepFinish, textEvent, toolEvent }

// ── filling in a sheet ─────────────────────────────────────────────────────

export interface Fill {
  /** The mark text after `mark:`; undefined leaves the line as drawn. */
  mark: (answer: KeyAnswer) => string | undefined
  /** The expected move; undefined leaves the line as drawn. */
  expected?: (fixture: KeyFixture) => string | undefined
}

/** Rewrites the `expected:` and `mark:` lines of a sheet outside any fence. */
export function fillSheet(sheet: string, key: SheetKey, fill: Fill): string {
  let moment: KeyFixture | undefined
  let answer: KeyAnswer | undefined
  let fence = 0
  return sheet
    .split('\n')
    .map((line) => {
      if (fence > 0) {
        if (new RegExp(`^~{${fence},}\\s*$`).test(line)) fence = 0
        return line
      }
      const open = /^(~{3,})/.exec(line)
      if (open) {
        fence = open[1]!.length
        return line
      }
      const m = /^## (s\d+)\s*$/.exec(line)
      if (m) {
        moment = key.fixtures.find((f) => f.label === m[1])
        answer = undefined
        return line
      }
      const a = /^#### (\S+)\s*$/.exec(line)
      if (a) {
        answer = key.answers.find((k) => k.id === a[1])
        return line
      }
      if (line.startsWith('expected:') && moment) {
        const text = fill.expected?.(moment)
        return text === undefined ? line : `expected: ${text}`
      }
      if (line.startsWith('mark:') && answer) {
        const text = fill.mark(answer)
        return text === undefined ? line : `mark: ${text}`
      }
      return line
    })
    .join('\n')
}

/** Marks every answer `changed=no`, then lets `over` change chosen ones. */
export const markAll =
  (over: (a: KeyAnswer) => string | undefined = () => undefined) =>
  (a: KeyAnswer): string =>
    over(a) ?? 'changed=no'
