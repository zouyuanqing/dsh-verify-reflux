/**
 * 20-level letter scale and template distributions.
 *
 * The verifier model self-reports a modal letter (A=worst .. T=best) plus a
 * confidence band; the orchestrator expands that into a fixed discrete
 * distribution over the scale and takes its expectation. This preserves the
 * LLM-as-a-Verifier probabilistic formulation — score = Σ p(letter)·value(letter)
 * — without requiring token-level logprobs from the serving endpoint.
 */

/** Ordered letters of the grading scale; index i carries value i/19. */
export const LETTERS = 'ABCDEFGHIJKLMNOPQRST' as const

export type Letter = (typeof LETTERS)[number]

export type Confidence = 'high' | 'medium' | 'low'

const N = LETTERS.length // 20

/** Map a letter to its position on the [0,1] scale. */
export function letterValue(letter: Letter): number {
  return LETTERS.indexOf(letter) / (N - 1)
}

/**
 * Fixed template distributions keyed by confidence. Offsets are relative to
 * the modal letter; probabilities are clamped at scale edges and renormalized.
 */
const TEMPLATES: Record<Confidence, Array<[offset: number, p: number]>> = {
  high: [
    [0, 0.7],
    [-1, 0.15],
    [1, 0.15],
  ],
  medium: [
    [0, 0.6],
    [-1, 0.15],
    [1, 0.15],
    [-2, 0.05],
    [2, 0.05],
  ],
  low: [
    [0, 0.4],
    [-1, 0.2],
    [1, 0.2],
    [-2, 0.1],
    [2, 0.1],
  ],
}

/**
 * Expand one (mode, confidence) judgment into a full distribution over the
 * 20 letters. Edge modes lose out-of-range offsets; remaining mass is
 * renormalized so the result always sums to 1.
 */
export function templateDist(mode: Letter, confidence: Confidence): number[] {
  const modeIdx = LETTERS.indexOf(mode)
  if (modeIdx < 0) throw new Error(`invalid grade letter: ${mode}`)
  const dist = new Array<number>(N).fill(0)
  for (const [offset, p] of TEMPLATES[confidence]) {
    const idx = modeIdx + offset
    if (idx >= 0 && idx < N) dist[idx]! += p
  }
  const total = dist.reduce((a, b) => a + b, 0)
  return dist.map((p) => p / total)
}

/** Expectation of the scale value under a distribution over letters. */
export function expectation(dist: number[]): number {
  let acc = 0
  for (let i = 0; i < N; i++) acc += (dist[i] ?? 0) * (i / (N - 1))
  return acc
}

/** Score one judgment: expand the template, then take the expectation. */
export function judgeScore(mode: Letter, confidence: Confidence): number {
  return expectation(templateDist(mode, confidence))
}

export function isLetter(value: unknown): value is Letter {
  return typeof value === 'string' && /^[A-T]$/.test(value)
}

export function isConfidence(value: unknown): value is Confidence {
  return value === 'high' || value === 'medium' || value === 'low'
}

/** Mean of a finite numeric series; empty input yields NaN like Math.mean would. */
export function mean(values: number[]): number {
  if (values.length === 0) return Number.NaN
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** Sample standard deviation (n-1); a single sample has no spread. */
export function stdev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}
