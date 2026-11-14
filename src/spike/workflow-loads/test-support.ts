/**
 * Fixtures for the workflow-loads tests: a sample declaration and a temp git repository whose declaration and marking rule
 * are committed at the default paths, so the gate passes. Not imported by production code.
 */
import { TestRepo } from '../../runner/test-support'
import { DECLARATION_PATH, type Declaration, MARKING_RULE_PATH, markingRuleHash } from './declaration'

export const SAMPLE_RULE_TEXT = '# Marking rule\n\nMark a stimulus when the decision rests on an unchecked premise.\n'

/** A valid declaration whose `marking_rule_hash` matches `SAMPLE_RULE_TEXT`. */
export function sampleDeclaration(overrides: Partial<Declaration> = {}): Declaration {
  return {
    schema_version: 1,
    window: { start: '2026-01-01', end: '2026-02-28' },
    session_cap: 40,
    scope_message_cap: 200,
    salt: 'sample-salt',
    excluded_project_roots: ['/excluded/project'],
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
