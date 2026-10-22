/**
 * Unit 1 spike: does `opencode run --format json` run in a workspace that
 * provably loads nothing from the author's machine, and do its events expose
 * enough to check "no method fired"?
 *
 * Scripted-provider tests are CI-safe (no network beyond fetching the pinned
 * npm package). The live smoke is opt-in: `METACOGS_LIVE=1 bun test src/runner/spike`.
 * When the pinned OpenCode cannot be launched the whole suite is skipped, with
 * a loud warning (see `opencodeAvailability`).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import {
  AUTH_CANARY,
  AUTHOR_CONFIG_MARKER,
  AUTHOR_EXTRA_SKILL_NAMES,
  AUTHOR_SKILL_BODY,
  AUTHOR_SKILL_NAME,
  buildChildEnv,
  buildUnisolatedControlEnv,
  createFixture,
  destroyFixture,
  type Fixture,
  OPENCODE_PIN,
  OUTSIDE_FILE_CANARY,
  plantAuthorHome,
  SENTINEL_AGENTS_MD,
} from './env'
import {
  assistantText,
  availableSkillsFromRequests,
  basePermission,
  buildConfig,
  debugCommand,
  gitInit,
  LIVE_MODEL,
  modelSeenText,
  offeredTools,
  opencodeAvailability,
  parseEvents,
  plantSkill,
  probeServe,
  type RunOutcome,
  type RunSpec,
  runOpencode,
  skillLoads,
  toolUses,
  totalUsage,
} from './isolation'
import {
  bashCallStep,
  SCRIPTED_USAGE,
  SPIKE_MODEL_ID,
  SPIKE_PROVIDER_ID,
  skillCallStep,
} from './scripted-provider'

const availability = opencodeAvailability()
const suite = describe.skipIf(!availability.available)
const LIVE = process.env.METACOGS_LIVE === '1'

const ARTIFACTS_OVERRIDE = process.env.METACOGS_SPIKE_ARTIFACTS
const ARTIFACTS = ARTIFACTS_OVERRIDE ?? mkdtempSync(join(tmpdir(), 'metacogs-spike-artifacts-'))
const fixtures: Fixture[] = []
const timings: { name: string; wallMs: number; firstEventMs?: number; tailMs?: number }[] = []

// Per-run timeout guard. bunx cold start can take tens of seconds on a fresh machine.
const RUN_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = RUN_TIMEOUT_MS + 60_000

const DENY_ALL = basePermission({ '*': 'deny' })
const ALLOW_DEMO = basePermission({ '*': 'deny', 'spike-demo': 'allow' })
const ALLOW_ALL = basePermission({ '*': 'allow' })
const DEMO_BODY = 'SPIKE_DEMO_BODY_MARKER_19d2'

function fixture(): Fixture {
  const f = createFixture()
  fixtures.push(f)
  return f
}

async function run(name: string, spec: RunSpec): Promise<RunOutcome> {
  const f = spec.fixture ?? fixture()
  const outcome = await runOpencode({
    timeoutMs: RUN_TIMEOUT_MS,
    ...spec,
    fixture: f,
    artifactDir: join(ARTIFACTS, name),
  })
  const stamps = outcome.parsed.events.map((e) => e.timestamp).filter((t): t is number => typeof t === 'number')
  timings.push({
    name,
    wallMs: outcome.wallMs,
    firstEventMs: stamps.length ? Math.min(...stamps) - outcome.startedAtMs : undefined,
    tailMs: stamps.length ? outcome.startedAtMs + outcome.wallMs - Math.max(...stamps) : undefined,
  })
  return outcome
}

function plantDemo(f: Fixture): void {
  const dir = plantSkill(f.workspace, 'spike-demo', DEMO_BODY)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'record.mjs'), '// spike helper\n')
}

/** Everything an observer could quote: raw stdout, stderr, and what the model was sent. */
function transcript(o: RunOutcome): string {
  return `${o.stdout}\n${o.stderr}\n${modelSeenText(o.requests)}`
}

afterAll(() => {
  for (const f of fixtures) destroyFixture(f)
  console.log(`\n[spike] artifacts: ${ARTIFACTS}${ARTIFACTS_OVERRIDE ? '' : ' (removed after the run; set METACOGS_SPIKE_ARTIFACTS to keep)'}`)
  console.log('[spike] timings (ms): name | wall | spawn→first event | last event→exit')
  for (const t of timings) {
    console.log(`  ${t.name} | ${t.wallMs} | ${t.firstEventMs ?? '-'} | ${t.tailMs ?? '-'}`)
  }
  if (!ARTIFACTS_OVERRIDE) rmSync(ARTIFACTS, { recursive: true, force: true })
})

suite(`OpenCode ${OPENCODE_PIN} isolation spike (scripted provider)`, () => {
  // ── happy: clean env ──────────────────────────────────────────────────
  describe('clean isolated env', () => {
    let outcome: RunOutcome
    let authorHome: ReturnType<typeof plantAuthorHome>

    test(
      'runs to completion with the generated config only',
      async () => {
        const f = fixture()
        // Author machine exists on disk but is NOT referenced by the child env.
        authorHome = plantAuthorHome(f.root)
        outcome = await run('clean', {
          fixture: f,
          prompt: 'Say hi.',
          permission: DENY_ALL,
          steps: [],
          finalText: 'hi from stub',
        })
        expect(outcome.timedOut).toBe(false)
        expect(outcome.exitCode).toBe(0)
        expect(outcome.parsed.nonJsonLines).toEqual([])
        expect(assistantText(outcome.parsed.events)).toBe('hi from stub')
      },
      TEST_TIMEOUT_MS,
    )

    test('child env contains no credential-shaped or METACOGS_* keys, no inherited HOME', () => {
      const keys = Object.keys(outcome.env)
      expect(keys.filter((k) => /KEY|TOKEN|SECRET|PASSWORD|^METACOGS_/i.test(k))).toEqual([])
      expect(outcome.env.HOME).toBe(outcome.fixture.home)
      expect(outcome.env.HOME).not.toBe(process.env.HOME)
      expect(outcome.env.HOME).not.toBe(authorHome.home)
    })

    test('model-visible <available_skills> is empty (block absent under deny-all)', () => {
      // Under `skill: {"*":"deny"}` the host omits the whole block and the skill
      // tool; the built-in `customize-opencode` skill is hidden too.
      expect(availableSkillsFromRequests(outcome.requests) ?? []).toEqual([])
      expect(offeredTools(outcome.requests)).not.toContain('skill')
    })

    test('sentinel AGENTS.md, author skills and canaries are absent from the transcript', () => {
      const t = transcript(outcome)
      for (const needle of [
        SENTINEL_AGENTS_MD,
        AUTH_CANARY,
        OUTSIDE_FILE_CANARY,
        AUTHOR_SKILL_BODY,
        AUTHOR_SKILL_NAME,
        AUTHOR_CONFIG_MARKER,
        authorHome.home,
      ]) {
        expect(t).not.toContain(needle)
      }
    })

    test(
      '`debug config` shows only the generated config plus empty defaults',
      async () => {
        const f = outcome.fixture
        const dc = await debugCommand(['config'], f, outcome.env)
        expect(dc.exitCode).toBe(0)
        const cfg = dc.json as Record<string, unknown>
        expect(cfg.permission).toEqual(outcome.config.permission)
        expect(cfg.small_model).toBeUndefined()
        expect(cfg.instructions).toBeUndefined()
        expect(JSON.stringify(cfg)).not.toContain(AUTHOR_CONFIG_MARKER)
        const generated = new Set(Object.keys(outcome.config))
        const hostDefaults = Object.keys(cfg).filter((k) => !generated.has(k))
        console.log(`[spike] debug config host-default keys: ${hostDefaults.join(',')}`)
        for (const k of hostDefaults) {
          const v = cfg[k]
          // defaults must be empty containers or scalars — nothing sourced from the machine
          expect(v === null || typeof v !== 'object' || Object.keys(v as object).length === 0 || k === 'compaction').toBe(true)
        }
        // key is masked by the host
        const providers = cfg.provider as Record<string, { options: { apiKey: string } }>
        expect(providers[SPIKE_PROVIDER_ID]?.options.apiKey).toBe('***')
      },
      TEST_TIMEOUT_MS,
    )

    test('step_finish exposes the provider-reported usage; timestamps are epoch ms', () => {
      const usage = totalUsage(outcome.parsed.events)
      console.log(`[spike] usage mapping: ${JSON.stringify(usage)}`)
      expect(usage.input).toBe(SCRIPTED_USAGE.prompt_tokens)
      expect(usage.output).toBe(SCRIPTED_USAGE.completion_tokens)
      for (const e of outcome.parsed.events) {
        expect(typeof e.timestamp).toBe('number')
        expect(e.timestamp).toBeGreaterThanOrEqual(outcome.startedAtMs)
        expect(e.timestamp).toBeLessThanOrEqual(outcome.startedAtMs + outcome.wallMs)
      }
    })
  })

  // ── happy: skill load ─────────────────────────────────────────────────
  describe('planted skill + allow rule', () => {
    let outcome: RunOutcome

    test(
      'skill-tool event names the skill and the result exposes the skill directory',
      async () => {
        outcome = await run('skill-allow', {
          prompt: 'Load the spike-demo skill.',
          permission: ALLOW_DEMO,
          prepare: plantDemo,
          steps: [skillCallStep('spike-demo')],
        })
        expect(outcome.exitCode).toBe(0)
        const loads = skillLoads(outcome.parsed.events)
        expect(loads).toHaveLength(1)
        const load = loads[0]!
        expect(load.status).toBe('completed')
        expect(load.input).toEqual({ name: 'spike-demo' })
        const skillDir = join(outcome.fixture.workspace, '.agents', 'skills', 'spike-demo')
        // macOS: tmpdir is a symlink (/var → /private/var); the host reports the realpath.
        expect(String(load.metadata?.dir).endsWith(`/workspace/.agents/skills/spike-demo`)).toBe(true)
        expect(load.output).toContain(DEMO_BODY)
        expect(load.output).toContain(`Base directory for this skill: ${load.metadata?.dir}`)
        expect(load.output).toContain('scripts/record.mjs')
        expect(existsSync(join(String(load.metadata?.dir), 'scripts', 'record.mjs'))).toBe(true)
        expect(existsSync(skillDir)).toBe(true)
      },
      TEST_TIMEOUT_MS,
    )

    test('model-visible <available_skills> is exactly the allowed set (built-in hidden)', () => {
      expect(availableSkillsFromRequests(outcome.requests)).toEqual(['spike-demo'])
      expect(offeredTools(outcome.requests)).toContain('skill')
    })

    test(
      '`debug skill` is pre-permission discovery (lists the built-in too) — not the loaded-skill instrument',
      async () => {
        const ds = await debugCommand(['skill'], outcome.fixture, outcome.env)
        const names = (ds.json as { name: string }[]).map((s) => s.name).sort()
        expect(names).toEqual(['customize-opencode', 'spike-demo'])
      },
      TEST_TIMEOUT_MS,
    )

    test(
      '`debug agent build` exposes the effective skill rules (preflight for live runs)',
      async () => {
        const da = await debugCommand(['agent', 'build'], outcome.fixture, outcome.env)
        const rules = (da.json as { permission: { permission: string; pattern: string; action: string }[] }).permission
        const skillRules = rules.filter((r) => r.permission === 'skill').map((r) => `${r.pattern}:${r.action}`)
        expect(skillRules).toEqual(['*:deny', 'spike-demo:allow'])
      },
      TEST_TIMEOUT_MS,
    )
  })

  // ── edge: deny-all ────────────────────────────────────────────────────
  describe('planted skill + deny-all', () => {
    test(
      'no skill tool, no completed skill event, skill body absent from transcript',
      async () => {
        const o = await run('skill-deny', {
          prompt: 'Load the spike-demo skill.',
          permission: DENY_ALL,
          prepare: plantDemo,
          steps: [skillCallStep('spike-demo')],
        })
        expect(o.exitCode).toBe(0)
        expect(offeredTools(o.requests)).not.toContain('skill')
        expect(availableSkillsFromRequests(o.requests) ?? []).toEqual([])
        expect(skillLoads(o.parsed.events)).toEqual([])
        expect(transcript(o)).not.toContain(DEMO_BODY)
        // A model that tries anyway lands on the host's `invalid` pseudo-tool.
        // The no-fire checker must treat this as an attempted fire, not silence.
        const attempts = toolUses(o.parsed.events)
        expect(attempts.map((t) => t.tool)).toEqual(['invalid'])
        expect(attempts[0]?.output).toContain("unavailable tool 'skill'")
      },
      TEST_TIMEOUT_MS,
    )
  })

  // ── shell allow-list ──────────────────────────────────────────────────
  describe('bash permission patterns', () => {
    test(
      '`node *scripts/record.mjs*` is allowed; any other command is denied',
      async () => {
        const f = fixture()
        const skillDir = plantSkill(f.workspace, 'spike-demo', DEMO_BODY)
        mkdirSync(join(skillDir, 'scripts'), { recursive: true })
        writeFileSync(join(skillDir, 'scripts', 'record.mjs'), "console.log('RECORD_RAN_OK_5c1e')\n")
        const o = await run('bash-allowlist', {
          fixture: f,
          prompt: 'Run the helper.',
          permission: ALLOW_DEMO,
          steps: [
            {
              toolCalls: [
                { id: 'b1', name: 'bash', arguments: { command: `node ${join(skillDir, 'scripts', 'record.mjs')}`, description: 'helper' } },
                { id: 'b2', name: 'bash', arguments: { command: 'echo denied-command', description: 'other' } },
              ],
            },
          ],
        })
        expect(o.exitCode).toBe(0)
        // Events arrive in completion order, not call order: match on callID.
        const byCall = new Map(toolUses(o.parsed.events).map((t) => [t.callID, t]))
        const allowed = byCall.get('b1')
        const denied = byCall.get('b2')
        expect(allowed?.status).toBe('completed')
        expect(allowed?.output).toContain('RECORD_RAN_OK_5c1e')
        expect(denied?.status).toBe('error')
        expect(denied?.error).toContain('prevents you from using this specific tool call')
      },
      TEST_TIMEOUT_MS,
    )
  })

  // ── error: outside read ───────────────────────────────────────────────
  describe('absolute-path reads outside the workspace', () => {
    test(
      'external_directory: deny blocks the read; denial is visible in events; canary never reaches the model',
      async () => {
        const f = fixture()
        const author = plantAuthorHome(f.root)
        const outside = join(f.root, 'outside')
        mkdirSync(outside)
        const outsideFile = join(outside, 'canary.txt')
        writeFileSync(outsideFile, OUTSIDE_FILE_CANARY)
        const o = await run('outside-read', {
          fixture: f,
          prompt: 'Read the files.',
          permission: DENY_ALL,
          steps: [
            {
              toolCalls: [
                { id: 'r1', name: 'read', arguments: { filePath: outsideFile } },
                { id: 'r2', name: 'read', arguments: { filePath: author.authJsonPath } },
                { id: 'r3', name: 'read', arguments: { filePath: author.agentsMdPath } },
              ],
            },
          ],
        })
        expect(o.exitCode).toBe(0)
        const reads = toolUses(o.parsed.events).filter((t) => t.tool === 'read')
        expect(reads).toHaveLength(3)
        for (const r of reads) {
          expect(r.status).toBe('error')
          expect(r.error).toContain('prevents you from using this specific tool call')
          expect(r.output).toBeUndefined()
        }
        const t = transcript(o)
        for (const needle of [OUTSIDE_FILE_CANARY, AUTH_CANARY, SENTINEL_AGENTS_MD]) {
          expect(t).not.toContain(needle)
        }
      },
      TEST_TIMEOUT_MS,
    )
  })

  // ── error: bad model ──────────────────────────────────────────────────
  describe('nonexistent model id', () => {
    test(
      'non-zero exit with a captured error event; does not hang',
      async () => {
        const o = await run('bad-model', {
          prompt: 'hi',
          model: `${SPIKE_PROVIDER_ID}/does-not-exist`,
          permission: DENY_ALL,
          steps: [],
          timeoutMs: 90_000,
        })
        expect(o.timedOut).toBe(false)
        expect(o.exitCode).not.toBe(0)
        const errors = o.parsed.events.filter((e) => e.type === 'error')
        expect(errors).toHaveLength(1)
        expect(typeof errors[0]?.error?.name).toBe('string')
        expect(o.requests).toEqual([]) // never reached the provider
      },
      TEST_TIMEOUT_MS,
    )
  })

  // ── ask behaviour ─────────────────────────────────────────────────────
  describe('`ask` permission in headless run', () => {
    test(
      'is auto-rejected (no block, no crash); the loop stops after the rejected call',
      async () => {
        const o = await run('ask-bash', {
          prompt: 'run something',
          permission: { ...DENY_ALL, bash: { '*': 'ask' } },
          steps: [bashCallStep('echo should-not-run')],
          timeoutMs: 90_000,
        })
        expect(o.timedOut).toBe(false)
        expect(o.exitCode).toBe(0)
        expect(o.stderr).toContain('permission requested: bash')
        expect(o.stderr).toContain('auto-rejecting')
        const bash = toolUses(o.parsed.events).filter((t) => t.tool === 'bash')
        expect(bash).toHaveLength(1)
        expect(bash[0]?.status).toBe('error')
        expect(bash[0]?.error).toContain('rejected permission')
        // no follow-up assistant text: the turn ends on the rejection
        expect(assistantText(o.parsed.events)).toBe('')
      },
      TEST_TIMEOUT_MS,
    )

    test(
      'explicit deny of a shell command surfaces as a tool error and the model gets a follow-up turn',
      async () => {
        const o = await run('deny-bash', {
          prompt: 'run something',
          permission: DENY_ALL,
          steps: [bashCallStep('echo should-not-run')],
          finalText: 'acknowledged',
        })
        expect(o.exitCode).toBe(0)
        const bash = toolUses(o.parsed.events).filter((t) => t.tool === 'bash')
        expect(bash[0]?.status).toBe('error')
        expect(bash[0]?.error).toContain('prevents you from using this specific tool call')
        expect(assistantText(o.parsed.events)).toBe('acknowledged')
      },
      TEST_TIMEOUT_MS,
    )
  })

  // ── cwd vs --dir, config injection channels ───────────────────────────
  describe('workspace selection and config injection', () => {
    test(
      '`--dir <ws>` from an unrelated cwd resolves the same workspace skills',
      async () => {
        const o = await run('dir-flag', {
          prompt: 'Load the spike-demo skill.',
          permission: ALLOW_DEMO,
          prepare: plantDemo,
          useDirFlag: true,
          steps: [skillCallStep('spike-demo')],
        })
        expect(o.exitCode).toBe(0)
        expect(skillLoads(o.parsed.events)).toHaveLength(1)
        expect(availableSkillsFromRequests(o.requests)).toEqual(['spike-demo'])
      },
      TEST_TIMEOUT_MS,
    )

    test(
      'OPENCODE_CONFIG_CONTENT alone is honored for `permission`',
      async () => {
        const o = await run('inject-content', {
          prompt: 'Load the spike-demo skill.',
          permission: DENY_ALL,
          prepare: plantDemo,
          injection: 'content',
          steps: [skillCallStep('spike-demo')],
        })
        expect(o.exitCode).toBe(0)
        expect(offeredTools(o.requests)).not.toContain('skill')
        expect(skillLoads(o.parsed.events)).toEqual([])
      },
      TEST_TIMEOUT_MS,
    )

    test(
      'OPENCODE_CONFIG file alone is honored for `permission` (skill allowed → loads)',
      async () => {
        const o = await run('inject-file', {
          prompt: 'Load the spike-demo skill.',
          permission: ALLOW_DEMO,
          prepare: plantDemo,
          injection: 'file',
          steps: [skillCallStep('spike-demo')],
        })
        expect(skillLoads(o.parsed.events)).toHaveLength(1)
      },
      TEST_TIMEOUT_MS,
    )

    test(
      'when both channels are set they deep-merge; on a same-key conflict OPENCODE_CONFIG_CONTENT wins',
      async () => {
        const content = buildConfig({ permission: DENY_ALL }, undefined)
        // Different keys merge: file adds `spike-demo: allow` on top of content's `*: deny`.
        const merged = await run('inject-merge', {
          prepare: plantDemo,
          prompt: 'Load the spike-demo skill.',
          permission: ALLOW_DEMO,
          steps: [skillCallStep('spike-demo')],
          extraEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: content.permission }) },
        })
        // Same key (`skill.*`): file says allow, content says deny.
        const conflict = await run('inject-conflict', {
          prepare: plantDemo,
          prompt: 'Load the spike-demo skill.',
          permission: ALLOW_ALL,
          steps: [skillCallStep('spike-demo')],
          extraEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: content.permission }) },
        })
        console.log(
          `[spike] file={*:deny,spike-demo:allow}+content={*:deny} → skills ${JSON.stringify(availableSkillsFromRequests(merged.requests))}; ` +
            `file={*:allow}+content={*:deny} → skill tool offered: ${offeredTools(conflict.requests).includes('skill')}`,
        )
        expect(availableSkillsFromRequests(merged.requests)).toEqual(['spike-demo'])
        expect(offeredTools(conflict.requests)).not.toContain('skill')
      },
      TEST_TIMEOUT_MS,
    )
  })

  // ── control: the instrument must detect a leak ────────────────────────
  describe('unisolated control (positive control for the instruments)', () => {
    test(
      'author skills, sentinel AGENTS.md and author config ARE detected when HOME is the author home',
      async () => {
        const f = fixture()
        const author = plantAuthorHome(f.root)
        const o = await run('control-unisolated', {
          fixture: f,
          prompt: 'Say hi.',
          permission: {},
          steps: [],
          envOverride: (fx, config) => buildUnisolatedControlEnv(author.home, fx, config),
        })
        expect(o.exitCode).toBe(0)
        const skills = availableSkillsFromRequests(o.requests) ?? []
        expect(skills).toContain(AUTHOR_SKILL_NAME)
        for (const n of AUTHOR_EXTRA_SKILL_NAMES) expect(skills).toContain(n)
        expect(modelSeenText(o.requests)).toContain(SENTINEL_AGENTS_MD)

        const dc = await debugCommand(['config'], f, buildUnisolatedControlEnv(author.home, f, o.config))
        expect((dc.json as { small_model?: string }).small_model).toBe(AUTHOR_CONFIG_MARKER)
      },
      TEST_TIMEOUT_MS,
    )

    test(
      'a managed-config dir would load and is visible in `debug config` (OPENCODE_TEST_MANAGED_CONFIG_DIR control)',
      async () => {
        const f = fixture()
        gitInit(f.workspace)
        const managed = join(f.root, 'managed')
        mkdirSync(managed)
        writeFileSync(join(managed, 'opencode.json'), JSON.stringify({ small_model: 'managed-leak/marker' }))
        const env = buildChildEnv({ fixture: f, config: buildConfig({ permission: DENY_ALL }, undefined) })
        const withManaged = await debugCommand(['config'], f, { ...env, OPENCODE_TEST_MANAGED_CONFIG_DIR: managed })
        expect((withManaged.json as { small_model?: string }).small_model).toBe('managed-leak/marker')
        const without = await debugCommand(['config'], f, env)
        expect((without.json as { small_model?: string }).small_model).toBeUndefined()
      },
      TEST_TIMEOUT_MS,
    )

    test('machine-level managed config locations are absent on this host', () => {
      const locations = [
        '/Library/Application Support/opencode',
        '/etc/opencode',
        `/Library/Managed Preferences/${userInfo().username}/ai.opencode.managed.plist`,
        '/Library/Managed Preferences/ai.opencode.managed.plist',
      ]
      const present = locations.filter((p) => existsSync(p))
      console.log(`[spike] managed config locations present: ${JSON.stringify(present)}`)
      // If this fails the host has machine-level config the env allowlist cannot isolate.
      expect(present).toEqual([])
    })
  })

  // ── transport comparison ──────────────────────────────────────────────
  describe('`opencode serve` surface', () => {
    test(
      '/experimental/tool is a registry listing, not the loaded-skill instrument',
      async () => {
        const f = fixture()
        gitInit(f.workspace)
        plantDemo(f)
        const config = buildConfig({ permission: ALLOW_DEMO }, 'http://127.0.0.1:1/v1')
        const env = buildChildEnv({ fixture: f, config })
        const probe = await probeServe(f, env, { provider: SPIKE_PROVIDER_ID, model: SPIKE_MODEL_ID })
        expect((probe.health as { version: string }).version).toBe(OPENCODE_PIN)
        expect(probe.toolsStatus).toBe(200)
        const tools = probe.tools as { id: string; description: string }[]
        const skill = tools.find((t) => t.id === 'skill')
        expect(skill).toBeDefined()
        // Neither the allowed skill nor `<available_skills>` appears in the tool description.
        expect(skill?.description).not.toContain('spike-demo')
        expect(skill?.description).not.toContain('<available_skills>')
        // And it is not permission-filtered: edit/write are listed though denied.
        expect(tools.map((t) => t.id)).toContain('edit')
      },
      TEST_TIMEOUT_MS,
    )
  })

  test('event parser tolerates non-JSON lines and keeps them', () => {
    const parsed = parseEvents('{"type":"text","part":{"text":"a"}}\nnot json\n[1]\n{"no":"type"}\n')
    expect(parsed.events).toHaveLength(1)
    expect(parsed.nonJsonLines).toEqual(['not json', '[1]', '{"no":"type"}'])
  })
})

// ── live ────────────────────────────────────────────────────────────────

const liveSuite = describe.skipIf(!availability.available || !LIVE)
if (availability.available && !LIVE) {
  console.warn('\n[spike] live smoke SKIPPED: set METACOGS_LIVE=1 to run it (one request to the free opencode/* tier)\n')
}

liveSuite(`live smoke (${LIVE_MODEL}, no API key in env)`, () => {
  test(
    'free-tier model answers with no credential and no auth.json; events carry usage',
    async () => {
      const f = fixture()
      const author = plantAuthorHome(f.root)
      const o = await run('live-smoke', {
        fixture: f,
        prompt: 'Reply with exactly the word: pong',
        model: LIVE_MODEL,
        permission: DENY_ALL,
        recordLive: true,
        timeoutMs: RUN_TIMEOUT_MS,
      })
      console.log(`[spike] live: exit=${o.exitCode} wall=${o.wallMs}ms usage=${JSON.stringify(totalUsage(o.parsed.events))} stderr=${JSON.stringify(o.stderr.slice(-300))}`)
      expect(Object.keys(o.env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k))).toEqual([])
      expect(existsSync(join(f.xdgDataHome, 'opencode', 'auth.json'))).toBe(false)
      expect(o.exitCode).toBe(0)
      expect(assistantText(o.parsed.events).toLowerCase()).toContain('pong')
      const usage = totalUsage(o.parsed.events)
      expect(usage.input).toBeGreaterThan(0)
      expect(usage.output).toBeGreaterThan(0)
      // model-visible truth via the recording proxy
      expect(o.requests.length).toBeGreaterThan(0)
      expect(availableSkillsFromRequests(o.requests) ?? []).toEqual([])
      const t = transcript(o)
      for (const needle of [SENTINEL_AGENTS_MD, AUTH_CANARY, AUTHOR_SKILL_BODY, author.home]) {
        expect(t).not.toContain(needle)
      }
    },
    TEST_TIMEOUT_MS,
  )
})

