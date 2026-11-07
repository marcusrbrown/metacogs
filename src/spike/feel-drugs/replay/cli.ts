/** `bun run replay`: extract session windows and manage frozen fixtures; prints counts, ids and statuses, never text. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { type CampaignCliDeps, CampaignUsageError, campaignCommand, statusCommand } from './campaign'
import { extractSession } from './extract'
import { approveFixture, assertOutsideRepo, buildFixture, freezeFixture, listFixtures, openStore, saveRaw, type StoreOptions } from './store'

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
  env?: Record<string, string | undefined>
  repoRoot?: string
  now?: () => Date
  /** Test seams for `campaign`. */
  campaign?: CampaignCliDeps
}

const USAGE = [
  'usage: bun run replay extract --db <path> --session <id> --cutoff <msgid> [--window N] --out <raw-name>',
  '       bun run replay build <spec.json> | freeze <id> | approve <id> | list',
  '       bun run replay campaign --name <n> --models <list> --arms <list|all> --fixtures <list|all> --cap <usd>',
  '                              [--provider scripted|cliproxy] [--auth-cliproxy <keyname>] [--attempt-estimate <usd>]',
  '                              [--timeout-ms N] [--again] [--expect-host-version <v>]',
  '       bun run replay status <campaign>',
].join('\n')

class UsageError extends Error {}

/** Exit 0 done, 1 refused or failed, 2 usage, 3 a campaign left cells unrun, 4 a credential leak. Runs `campaign` too, which is async. */
export async function mainAsync(argv: readonly string[], io: Partial<CliIo> = {}): Promise<number> {
  if (argv[0] !== 'campaign') return main(argv, io)
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))
  try {
    const parsed = parse(argv)
    const storeOptions: StoreOptions = { ...(io.env ? { env: io.env } : {}), ...(io.repoRoot ? { repoRoot: io.repoRoot } : {}), ...(io.now ? { now: io.now } : {}) }
    return await campaignCommand(parsed.values, { store: openStore(storeOptions), out, env: io.env ?? process.env, ...(io.campaign ? { deps: io.campaign } : {}) })
  } catch (e) {
    if (e instanceof CampaignUsageError || (e instanceof TypeError && 'code' in e)) {
      err(`${e.message}\n${USAGE}`)
      return 2
    }
    err(e instanceof Error ? `${e.name}: ${e.message}` : 'unexpected error')
    return 1
  }
}

/** Exit 0 done, 1 refused or failed, 2 usage. */
export function main(argv: readonly string[], io: Partial<CliIo> = {}): number {
  const out = io.out ?? ((line: string) => console.log(line))
  const err = io.err ?? ((line: string) => console.error(line))
  try {
    return run(argv, { out, err }, io)
  } catch (e) {
    if (e instanceof UsageError || e instanceof CampaignUsageError) {
      err(`${e.message}\n${USAGE}`)
      return 2
    }
    // Our own errors name fields, rules and ids, never content.
    err(e instanceof Error ? `${e.name}: ${e.message}` : 'unexpected error')
    return 1
  }
}

function run(argv: readonly string[], log: Pick<CliIo, 'out' | 'err'>, io: Partial<CliIo>): number {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : 'bad arguments')
  }
  const [command, arg] = parsed.positionals
  const { values } = parsed
  const storeOptions: StoreOptions = { ...(io.env ? { env: io.env } : {}), ...(io.repoRoot ? { repoRoot: io.repoRoot } : {}), ...(io.now ? { now: io.now } : {}) }
  const need = (value: string | undefined, what: string): string => value ?? fail(`${command} needs ${what}`)

  switch (command) {
    case 'extract': {
      const db = need(values.db, '--db')
      const session = need(values.session, '--session')
      const cutoff = need(values.cutoff, '--cutoff')
      const name = need(values.out, '--out')
      const window = values.window === undefined ? undefined : Number(values.window)
      if (window !== undefined && (!Number.isInteger(window) || window < 1)) fail('--window takes a positive integer')
      const store = openStore(storeOptions)
      const raw = extractSession({ db: resolve(db), session, cutoff, ...(window !== undefined ? { window } : {}) })
      saveRaw(store, name, raw)
      log.out(`extracted ${name} messages=${raw.messages.length} parts=${raw.parts.length} total=${raw.total_messages} compaction=${raw.compaction_message_ids.length} window=${raw.window ?? 'all'}`)
      return 0
    }
    case 'build': {
      const file = resolve(arg ?? fail('build needs a spec file'))
      const store = openStore(storeOptions)
      assertOutsideRepo(file, store.repoRoot)
      let json: unknown
      try {
        json = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        throw new Error('the spec file is not readable JSON')
      }
      const entry = buildFixture(store, json)
      const id = (json as { id: string }).id
      log.out(entry.status === 'excluded' ? `built ${id} status=excluded reason=${entry.reason}` : `built ${id} status=${entry.status} export_sha256=${entry.export_sha256.slice(0, 12)}`)
      return 0
    }
    case 'freeze': {
      const id = arg ?? fail('freeze needs a fixture id')
      const entry = freezeFixture(openStore(storeOptions), id)
      log.out(`frozen ${id} files=${entry.stamp.files} hash=${entry.stamp.hash.slice(0, 12)}`)
      return 0
    }
    case 'approve': {
      const id = arg ?? fail('approve needs a fixture id')
      const entry = approveFixture(openStore(storeOptions), id)
      log.out(`approved ${id} at=${entry.review.at}`)
      return 0
    }
    case 'list': {
      for (const f of listFixtures(openStore(storeOptions))) log.out(`${f.id}\t${f.kind ?? '?'}\t${f.status}\t${f.approved ? 'approved' : 'unapproved'}`)
      return 0
    }
    case 'status':
      return statusCommand(arg, { store: openStore(storeOptions), out: log.out })
    case 'campaign':
      return fail('campaign runs through mainAsync')
    default:
      return fail(command ? `unknown command ${command}` : 'no command given')
  }
}

const fail = (message: string): never => {
  throw new UsageError(message)
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      session: { type: 'string' },
      cutoff: { type: 'string' },
      window: { type: 'string' },
      out: { type: 'string' },
      name: { type: 'string' },
      models: { type: 'string' },
      arms: { type: 'string' },
      fixtures: { type: 'string' },
      cap: { type: 'string' },
      provider: { type: 'string' },
      'auth-cliproxy': { type: 'string' },
      'attempt-estimate': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'expect-host-version': { type: 'string' },
      again: { type: 'boolean' },
    },
  })
}

if (import.meta.main) process.exitCode = await mainAsync(process.argv.slice(2))
