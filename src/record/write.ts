import { randomBytes } from 'node:crypto'
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { canonicalize, canonicalPayload, recordFilename } from './canonical'
import type { StampedRecord } from './contract'

/** Failure to resolve, create, or write under the output root. Maps to exit 3. */
export class RecordIoError extends Error {
  override readonly name = 'RecordIoError'
}

/** The final path already holds different (or unparseable/truncated) content. Maps to exit 4. */
export class RecordCollisionError extends Error {
  override readonly name = 'RecordCollisionError'
  constructor(readonly path: string) {
    super(`${path} already exists with different content; refusing to overwrite`)
  }
}

export interface ResolveRootInput {
  outDir?: string | undefined
  env: Readonly<Record<string, string | undefined>>
  cwd: string
  home: string
}

const set = (value: string | undefined): value is string => value !== undefined && value !== ''

/**
 * Output root precedence: --out-dir, METACOGS_RECORDS_DIR, $XDG_STATE_HOME/metacogs/records,
 * ~/.local/state/metacogs/records. The cwd is only used to anchor an explicitly given relative path.
 */
export function resolveRoot({ outDir, env, cwd, home }: ResolveRootInput): string {
  if (set(outDir)) return resolve(cwd, outDir)
  const fromEnv = env.METACOGS_RECORDS_DIR
  if (set(fromEnv)) return resolve(cwd, fromEnv)
  const xdg = env.XDG_STATE_HOME
  // The XDG spec says a relative value is invalid and must be ignored.
  if (set(xdg) && isAbsolute(xdg)) return join(xdg, 'metacogs', 'records')
  return join(home, '.local', 'state', 'metacogs', 'records')
}

export interface WriteResult {
  path: string
  /** `written`: this call created the file. `exists`: an equivalent record was already there. */
  status: 'written' | 'exists'
}

function assertDirectChild(root: string, path: string): void {
  const rel = relative(root, path)
  if (rel === '' || isAbsolute(rel) || rel.startsWith('..') || rel.includes(sep)) {
    throw new RecordIoError(`resolved path ${path} is not a direct child of the output root ${root}`)
  }
}

const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code

/** Same record already on disk? Byte-identical, or identical canonical payload (differing only in helper_version). */
async function isEquivalent(path: string, expectedBytes: string, record: StampedRecord): Promise<boolean> {
  const existing = await readFile(path, 'utf8')
  if (existing === expectedBytes) return true
  try {
    return canonicalPayload(JSON.parse(existing)) === canonicalPayload(record)
  } catch {
    return false // truncated or not JSON
  }
}

/**
 * Atomic, idempotent write: complete temp file in the same directory, then link(2) it to the final name.
 * link fails with EEXIST instead of replacing, so a concurrent or earlier writer is never clobbered.
 */
export async function writeRecord({ root, record }: { root: string; record: StampedRecord }): Promise<WriteResult> {
  let name: string
  let bytes: string
  try {
    name = recordFilename(record)
    bytes = `${canonicalize(record)}\n`
  } catch (error) {
    throw new RecordIoError(`cannot serialize record: ${(error as Error).message}`)
  }

  const resolvedRoot = resolve(root)
  const final = resolve(resolvedRoot, name)
  assertDirectChild(resolvedRoot, final)

  try {
    await mkdir(resolvedRoot, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new RecordIoError(`cannot create ${resolvedRoot}: ${(error as Error).message}`)
  }

  const tmp = join(resolvedRoot, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  let tmpCreated = false
  try {
    const handle = await open(tmp, 'wx', 0o600)
    tmpCreated = true
    try {
      await handle.writeFile(bytes, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await link(tmp, final)
      return { path: final, status: 'written' }
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error
    }
    // EEXIST: someone (maybe us, earlier) already wrote this name.
    if (await isEquivalent(final, bytes, record)) return { path: final, status: 'exists' }
    throw new RecordCollisionError(final)
  } catch (error) {
    if (error instanceof RecordCollisionError || error instanceof RecordIoError) throw error
    throw new RecordIoError(`cannot write ${final}: ${(error as Error).message}`)
  } finally {
    if (tmpCreated) await unlink(tmp).catch(() => undefined)
  }
}
