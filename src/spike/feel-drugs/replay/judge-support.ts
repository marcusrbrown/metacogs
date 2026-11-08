/** Synthetic campaigns for the judge tests. Synthetic text only. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ARM_NAMES, type ArmName, REPLAY_MODELS } from './gates'
import type { AttemptJob } from './host'
import { type CampaignOptions, runCampaign } from './run'
import { approvedFixture, fakeExecutor, stdoutOf, stepFinish, textEvent, toolEvent } from './test-support'
import { openStore, type FixtureSpec, type Store } from './store'

export const OUTCOME_REF = 'UNIQUE-OUTCOME-REF-7731'
export const WORKED = 'Run the checks next.'

export interface JudgeLab {
  store: Store
  state: string
  repoRoot: string
  env: Record<string, string | undefined>
  dispose(): void
}

/** A store at the layout the command line opens: `<state>/metacogs/replay`. */
export function newJudgeLab(): JudgeLab {
  const base = mkdtempSync(join(tmpdir(), 'replay-judge-'))
  const state = join(base, 'state')
  const repoRoot = join(base, 'repo')
  mkdirSync(repoRoot)
  mkdirSync(state)
  const env = { XDG_STATE_HOME: state }
  const store = openStore({ env, repoRoot, now: () => new Date('2026-11-07T12:00:00.000Z') })
  return { store, state, repoRoot, env, dispose: () => rmSync(base, { recursive: true, force: true }) }
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
export async function runSyntheticCampaign(lab: JudgeLab, plan: CampaignPlan): Promise<string> {
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
