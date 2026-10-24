/**
 * The mechanical word limit (rubric `TE3m`): one named check, not a rubric interpreter. It runs after the judge, so the judge's
 * TE verdicts are on the manifest whatever the length, and it never enters `judge.criteria`.
 */

/** Whitespace-separated tokens. Empty and whitespace-only text is 0 words. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** Inclusive: exactly `maxWords` words is within the limit. */
export function isOverLimit(wordCount: number, maxWords: number): boolean {
  return wordCount > maxWords
}
