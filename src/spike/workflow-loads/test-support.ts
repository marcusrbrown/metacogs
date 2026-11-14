/**
 * Fixtures for the workflow-loads tests: a sample declaration and a temp git repository whose declaration and marking rule
 * are committed at the default paths, so the gate passes. Not imported by production code.
 */
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TestRepo } from '../../runner/test-support'
import { DECLARATION_PATH, type Declaration, MARKING_RULE_PATH, markingRuleHash, projectRootHash } from './declaration'

/** Value held only in a table the reader must never query. */
export const SENTINEL = 'SENTINEL_NEVER_READ'

export const SAMPLE_SALT = 'sample-salt'
/** The project root the sample declaration excludes (held there only as a salted hash). */
export const EXCLUDED_ROOT = '/excluded/project'

export const SAMPLE_RULE_TEXT = '# Marking rule\n\nMark a stimulus when the decision rests on an unchecked premise.\n'

/** A valid declaration whose `marking_rule_hash` matches `SAMPLE_RULE_TEXT`. */
export function sampleDeclaration(overrides: Partial<Declaration> = {}): Declaration {
  return {
    schema_version: 1,
    window: { start: '2026-01-01', end: '2026-02-28' },
    session_cap: 40,
    scope_message_cap: 200,
    salt: SAMPLE_SALT,
    excluded_project_root_hashes: [projectRootHash(SAMPLE_SALT, EXCLUDED_ROOT)],
    decision_bearing_tools: ['task', 'question'],
    marking_rule_hash: markingRuleHash(SAMPLE_RULE_TEXT),
    min_accepted_marks: {
      counterfactual: { expected_fire: 5, expected_silence: 3 },
      synthesis: { expected_fire: 5, expected_silence: 3 },
    },
    omission: { sample_size: 20, limit: 2 },
    retry_count: 1,
    outcome_rule: 'errors-first',
    labeler: { model_id: 'sample/labeler-model', endpoint: 'https://proxy.example.invalid/v1' },
    spend_cap_usd: 10,
    ...overrides,
  }
}

export function writeDeclaration(repo: TestRepo, declaration: Declaration, path = DECLARATION_PATH): void {
  repo.write(path, `${JSON.stringify(declaration, null, 2)}\n`)
}

/** A temp repository with the sample declaration and rule committed at the default paths. The caller destroys it. */
export function gatedRepo(overrides: Partial<Declaration> = {}): { repo: TestRepo; declaration: Declaration } {
  const repo = new TestRepo('metacogs-workflow-loads-')
  const declaration = sampleDeclaration(overrides)
  repo.write(MARKING_RULE_PATH, SAMPLE_RULE_TEXT)
  writeDeclaration(repo, declaration)
  repo.commit('declaration and rule', [DECLARATION_PATH, MARKING_RULE_PATH])
  return { repo, declaration }
}

// ── a synthetic OpenCode session store ─────────────────────────────────────

export interface SyntheticStore {
  /** Path of the SQLite file. */
  path: string
  /** The writer connection; keep using it to grow the store after a manifest was frozen. */
  db: Database
  /** `created` is epoch milliseconds or a `YYYY-MM-DD` day (noon UTC). */
  addSession(input: { id: string; created: string | number; directory?: string; parent?: string }): void
  /** Appends a message to a session; ids and times only ever increase. */
  addMessage(session: string, role: 'user' | 'assistant'): string
  /** Appends a part (its JSON `data`) to a message. */
  addPart(message: string, data: Record<string, unknown>): string
  addText(message: string, text: string): string
  addTool(message: string, call: { tool: string; input?: Record<string, unknown>; output?: string; status?: string }): string
  /** A completed call to a skill-loading tool; the output is a `<skill_content>` block. */
  addSkillCall(message: string, name: string, options?: { tool?: 'skill' | 'systematic_skill'; status?: string; output?: string }): string
  /** A completed `read` of a file; the output is numbered the way the host numbers it. */
  addRead(message: string, filePath: string, content: string): string
  destroy(): void
}

/** The `<skill_content>` block a skill load returns. */
export function skillOutput(name: string, body = 'Synthetic skill body.'): string {
  return `<skill_content name="${name}">\n# Skill: ${name}\n\n${body}\n</skill_content>`
}

/** What the `read` tool returns for a file: a path header, then each line numbered. */
export function numberedRead(filePath: string, content: string): string {
  return `<path>${filePath}</path>\n<content>\n${content
    .split('\n')
    .map((line, i) => `${i + 1}: ${line}`)
    .join('\n')}\n</content>`
}

const day = (value: string | number): number => (typeof value === 'number' ? value : Date.parse(`${value}T12:00:00Z`))

/**
 * A temp SQLite store with the three tables the reader may query and a decoy `account` table holding a sentinel value. Pass
 * `omitTable` to build a store that lacks one of the three. The caller destroys it.
 */
export function syntheticStore(options: { omitTable?: 'session' | 'message' | 'part' } = {}): SyntheticStore {
  const dir = mkdtempSync(join(tmpdir(), 'metacogs-workflow-loads-store-'))
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  const tables: Record<string, string> = {
    session: 'CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, permission TEXT, share_url TEXT, time_created INTEGER, time_updated INTEGER)',
    message: 'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
    part: 'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)',
  }
  for (const [name, ddl] of Object.entries(tables)) if (name !== options.omitTable) db.run(ddl)
  db.run('CREATE TABLE account (id TEXT, access_token TEXT)')
  db.run(`INSERT INTO account VALUES ('a1', '${SENTINEL}')`)

  let seq = 0
  let clock = Date.parse('2026-01-01T00:00:00Z')
  const sessionOfMessage = new Map<string, string>()
  const next = (prefix: string) => `${prefix}_${String(++seq).padStart(6, '0')}`

  const store: SyntheticStore = {
    path,
    db,
    addSession({ id, created, directory = '/work/app', parent }) {
      db.run('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, 'proj', parent ?? null, 'slug', directory, `title ${id}`, SENTINEL, SENTINEL, day(created), day(created)])
    },
    addMessage(session, role) {
      const id = next('msg')
      sessionOfMessage.set(id, session)
      clock += 1
      db.run('INSERT INTO message VALUES (?, ?, ?, ?, ?)', [id, session, clock, clock, JSON.stringify({ role })])
      return id
    },
    addPart(message, data) {
      const id = next('prt')
      clock += 1
      db.run('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)', [id, message, sessionOfMessage.get(message) ?? '', clock, clock, JSON.stringify(data)])
      return id
    },
    addText: (message, text) => store.addPart(message, { type: 'text', text }),
    addTool: (message, { tool, input = {}, output = 'ok', status = 'completed' }) =>
      store.addPart(message, { type: 'tool', callID: `call_${seq + 1}`, tool, state: { status, input, output, title: tool, metadata: {}, time: { start: 1, end: 2 } } }),
    addSkillCall: (message, name, o = {}) => store.addTool(message, { tool: o.tool ?? 'skill', input: { name }, output: o.output ?? skillOutput(name), status: o.status ?? 'completed' }),
    addRead: (message, filePath, content) => store.addTool(message, { tool: 'read', input: { filePath }, output: numberedRead(filePath, content) }),
    destroy() {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return store
}

/** A top-level session that loaded a workflow skill in its first assistant message, after one user message. */
export function seedWorkflowSession(
  store: SyntheticStore,
  input: { id: string; created: string | number; directory?: string; skill?: string; tool?: 'skill' | 'systematic_skill' },
): { user: string; assistant: string; load: string } {
  store.addSession({ id: input.id, created: input.created, ...(input.directory ? { directory: input.directory } : {}) })
  const user = store.addMessage(input.id, 'user')
  store.addText(user, 'start the workflow')
  const assistant = store.addMessage(input.id, 'assistant')
  const load = store.addSkillCall(assistant, input.skill ?? 'ce:plan', { tool: input.tool ?? 'skill' })
  return { user, assistant, load }
}
