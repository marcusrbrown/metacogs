/**
 * Private near-duplicate check: a held-out fixture that copies a dev fixture
 * measures memorization of the dev set, not the skill. Word 3-gram Jaccard
 * similarity over the canonical text. The only committed output is pass/fail;
 * the pair ids and scores go to the local terminal and nowhere else.
 */

export const NEAR_DUPLICATE_THRESHOLD = 0.5

function shingles(text: string, size = 3): Set<string> {
  const words = text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  const out = new Set<string>()
  if (words.length < size) {
    if (words.length) out.add(words.join(' '))
    return out
  }
  for (let i = 0; i + size <= words.length; i += 1) out.add(words.slice(i, i + size).join(' '))
  return out
}

/** Jaccard similarity of the two texts' word 3-gram sets; 0 when either is empty. */
export function similarity(a: string, b: string): number {
  const sa = shingles(a)
  const sb = shingles(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let shared = 0
  for (const s of sa) if (sb.has(s)) shared += 1
  return shared / (sa.size + sb.size - shared)
}

export interface NearDuplicate {
  heldout: string
  dev: string
  similarity: number
}

interface Doc {
  id: string
  text: string
}

/** Every held-out/dev pair at or above the threshold, most similar first. */
export function findNearDuplicates(heldout: readonly Doc[], dev: readonly Doc[], threshold = NEAR_DUPLICATE_THRESHOLD): NearDuplicate[] {
  const hits: NearDuplicate[] = []
  for (const h of heldout) {
    for (const d of dev) {
      const s = similarity(h.text, d.text)
      if (s >= threshold) hits.push({ heldout: h.id, dev: d.id, similarity: Math.round(s * 1000) / 1000 })
    }
  }
  return hits.sort((a, b) => b.similarity - a.similarity)
}
