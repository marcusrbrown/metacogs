/** `bun run replay world specs | build | list`: prepare the real-world scenarios. Prints ids, counts and rules, never text. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildWorldScenario, generateWorldSpecs, listWorldScenarios, readWorldSpec, type ScenarioMeta, WORLD_SCENARIOS, worldDir } from './scenario'
import type { Store } from './store'
import { checkoutOf, cloneWorld, type WorldRecord } from './world'

export class WorldUsageError extends Error {}

export interface WorldValues {
  db?: string | undefined
  fixtures?: string | undefined
  budget?: string | undefined
  resolve?: boolean | undefined
  force?: boolean | undefined
}

export const defaultDb = (home = homedir()): string => join(home, '.local', 'share', 'opencode', 'opencode.db')

const ids = (spec: string | undefined, fallback: readonly string[]): string[] => (spec === undefined || spec === 'all' ? [...fallback] : spec.split(',').map((s) => s.trim()).filter(Boolean))

/** Where the scenario would land today: clones into a temp directory of its own, reads the commit and rule, and deletes it. */
export function resolveScenarioWorld(store: Store, id: string, ctx: { home?: string } = {}): WorldRecord {
  const spec = readWorldSpec(store, id)
  const meta = buildMetaOf(store, id)
  const checkout = checkoutOf(spec.project, { ...(ctx.home ? { home: ctx.home } : {}), repoRoot: store.repoRoot })
  const dest = mkdtempSync(join(tmpdir(), 'replay-resolve-'))
  try {
    return cloneWorld({ source: checkout.path, dest, githubRepo: checkout.github, cutoffMs: meta.cutoff.time_ms, hints: meta.branch_hints })
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
}

const buildMetaOf = (store: Store, id: string): ScenarioMeta => JSON.parse(readFileSync(join(worldDir(store, id), 'meta.json'), 'utf8')) as ScenarioMeta

/** Exit 0 done. Throws `WorldUsageError` for a bad invocation. */
export function worldCommand(sub: string | undefined, values: WorldValues, ctx: { store: Store; out: (line: string) => void; home?: string }): number {
  const db = values.db ?? defaultDb(ctx.home)
  switch (sub) {
    case 'specs': {
      for (const r of generateWorldSpecs(ctx.store, { db, ids: ids(values.fixtures, WORLD_SCENARIOS), force: values.force === true })) ctx.out(`spec ${r.id} ${r.status} author_next_turn=${r.has_author_next_turn ? 'yes' : 'no'}`)
      return 0
    }
    case 'build': {
      const budget = values.budget === undefined ? undefined : Number(values.budget)
      if (budget !== undefined && !(Number.isInteger(budget) && budget > 0)) throw new WorldUsageError('--budget takes a positive integer (tokens)')
      for (const id of ids(values.fixtures, WORLD_SCENARIOS)) {
        const meta = buildWorldScenario(ctx.store, id, { db, ...(budget ? { budget } : {}) })
        const w = meta.window
        const types = Object.entries(meta.part_types).map(([t, n]) => `${t}=${n}`).join(',')
        ctx.out(`built ${id} window=${w.rule} messages=${w.messages}/${w.total_messages} tokens≈${w.token_estimate}/${w.budget}${w.over_budget ? ' OVER' : ''} dropped=${meta.dropped.total} parts=${types} branch_hints=${meta.branch_hints.length}`)
        if (values.resolve) {
          const world = resolveScenarioWorld(ctx.store, id, ctx.home ? { home: ctx.home } : {})
          ctx.out(`world ${id} repo=${world.repo} commit=${world.commit.slice(0, 12)} rule=${world.rule}${world.branch ? ` branch=${world.branch}` : ''}${world.oldest_available ? ' oldest_available' : ''} cutoff=${world.cutoff}`)
        }
      }
      return 0
    }
    case 'list': {
      for (const s of listWorldScenarios(ctx.store)) ctx.out(`${s.id}\t${s.built ? 'built' : 'spec-only'}`)
      return 0
    }
    default:
      throw new WorldUsageError(sub ? `unknown world command ${sub}` : 'world needs specs | build | list')
  }
}
