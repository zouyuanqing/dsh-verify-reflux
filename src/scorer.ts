import { isConfidence, isLetter, judgeScore, mean, stdev } from './scale.js'
import type { Confidence, Letter } from './scale.js'
import { completeText } from './llm.js'
import type { LlmStreamService } from './llm.js'

export type Criteria = Record<string, string>

export interface Judgment {
  letter: Letter
  confidence: Confidence
}

/** One judged candidate: per-criterion modal judgments across all repeats. */
export interface CandidateJudgment {
  index: number
  /** criterion name -> one judgment per repeat */
  byCriterion: Record<string, Judgment[]>
  /** aggregated score in [0,1]: mean over criteria of mean over repeats */
  score: number
  /** spread across repeats, averaged over criteria */
  spread: number
}

const SYSTEM =
  'You are a skeptical, independent reviewer grading candidate solutions. ' +
  'Grade on a 20-letter scale where A means total failure (0%) and T means flawless (100%). ' +
  'Judge each criterion separately. Before judging, silently run an execution test: list the most ' +
  'likely ways this candidate fails in production and check whether it guards against them. ' +
  'Output ONLY minified JSON matching the requested shape — no prose, no markdown fences.'

function criteriaBlock(criteria: Criteria): string {
  return Object.entries(criteria)
    .map(([name, desc]) => `- ${name}: ${desc}`)
    .join('\n')
}

/**
 * Build the user prompt for one directed comparison. Presentation order is
 * caller-rotated between repeats to break position bias.
 */
export function buildPairwisePrompt(args: {
  problem: string
  first: { label: string; body: string }
  second: { label: string; body: string }
  criteria: Criteria
  perspective: string
}): string {
  return [
    `## Problem\n${args.problem}`,
    `## Criteria\n${criteriaBlock(args.criteria)}`,
    `## Reviewer stance\n${args.perspective}`,
    `## Candidate ${args.first.label}\n${args.first.body}`,
    `## Candidate ${args.second.label}\n${args.second.body}`,
    'For EACH criterion judge both candidates independently.',
    'Respond with ONLY minified JSON:',
    `{"${args.first.label}":{"<criterion>":["<letter>","high|medium|low"]},"` +
      `${args.second.label}":{...}}`,
  ].join('\n\n')
}

/**
 * Extract the outermost JSON object from model text. Tolerates prose fences,
 * leading labels and trailing commentary — models ignore output contracts at
 * their own peril, parsers should not compound that error.
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) throw new ScoreParseError('no JSON object found', text)
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      if (inString) escaped = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as unknown
    }
  }
  throw new ScoreParseError('unbalanced JSON object', text)
}

export class ScoreParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message)
    this.name = 'ScoreParseError'
  }
}

function parseJudgment(value: unknown, context: string): Judgment {
  if (!Array.isArray(value) || value.length < 2) {
    throw new ScoreParseError(`${context}: expected ["letter","confidence"]`, JSON.stringify(value))
  }
  const [letter, confidence] = value as [unknown, unknown]
  if (!isLetter(letter) || !isConfidence(confidence)) {
    throw new ScoreParseError(`${context}: invalid letter/confidence`, JSON.stringify(value))
  }
  return { letter, confidence }
}

function parseSide(side: unknown, label: string, criteriaNames: string[]): Record<string, Judgment[]> {
  if (typeof side !== 'object' || side === null) {
    throw new ScoreParseError(`${label}: expected object`, String(side))
  }
  const record = side as Record<string, unknown>
  const out: Record<string, Judgment[]> = {}
  for (const name of criteriaNames) {
    // Models sometimes echo criteria keys with different casing/spacing; match loosely.
    const key = Object.keys(record).find((k) => k.trim().toLowerCase() === name.trim().toLowerCase())
    if (!key) throw new ScoreParseError(`${label}: missing criterion "${name}"`, JSON.stringify(record))
    const value = record[key]
    out[name] = [parseJudgment(Array.isArray(value) ? value : value, `${label}.${name}`)]
  }
  return out
}

/** Convert one repeat's judgments into per-criterion scores. */
function judgmentScores(js: Record<string, Judgment[]>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, list] of Object.entries(js)) {
    out[name] = mean(list.map((j) => judgeScore(j.letter, j.confidence)))
  }
  return out
}

const PERSPECTIVES = [
  'a correctness engineer hunting for logic errors',
  'a security auditor probing for exploitable flaws',
  'a performance engineer watching for pathological costs',
]

export interface PairwiseResult {
  scores: [number, number]
  spreads: [number, number]
  perRepeat: Array<{ first: Record<string, Judgment>; second: Record<string, Judgment> }>
  failures: number
  raw: string[]
}

export interface PairwiseOptions {
  repeats?: number
  signal?: AbortSignal
}

/**
 * Score two candidates against shared criteria. Each repeat rotates reviewer
 * stance AND swaps presentation order, so position bias and single-perspective
 * blindness average out instead of compounding.
 */
export async function comparePair(
  llm: LlmStreamService,
  route: { provider: string; model: string },
  problem: string,
  candidateA: string,
  candidateB: string,
  criteria: Criteria,
  options: PairwiseOptions = {},
): Promise<PairwiseResult> {
  const names = Object.keys(criteria)
  const repeats = Math.max(1, options.repeats ?? 2)
  const perRepeat: PairwiseResult['perRepeat'] = []
  const raw: string[] = []
  const firstScores: number[][] = [] // repeat -> per-criterion (first candidate)
  const secondScores: number[][] = []

  for (let r = 0; r < repeats; r++) {
    options.signal?.throwIfAborted()
    const swap = r % 2 === 1
    const perspective = PERSPECTIVES[r % PERSPECTIVES.length]!
    const prompt = buildPairwisePrompt({
      problem,
      first: { label: swap ? 'B' : 'A', body: swap ? candidateB : candidateA },
      second: { label: swap ? 'A' : 'B', body: swap ? candidateA : candidateB },
      criteria,
      perspective,
    })
    let text: string
    try {
      text = await completeText(llm, { ...route, system: SYSTEM, prompt, signal: options.signal })
    } catch (err) {
      if (options.signal?.aborted) throw err
      raw.push(`repeat ${r}: transport failure: ${String(err)}`)
      continue
    }
    raw.push(text)
    try {
      const parsed = parseSide((extractJson(text) as Record<string, unknown>)[swap ? 'B' : 'A'], 'first', names)
      const parsedSecond = parseSide((extractJson(text) as Record<string, unknown>)[swap ? 'A' : 'B'], 'second', names)
      // Un-swap so index 0 is always candidate A.
      const first = swap ? parsedSecond : parsed
      const second = swap ? parsed : parsedSecond
      perRepeat.push({
        first: Object.fromEntries(Object.entries(first).map(([k, v]) => [k, v[0]!])),
        second: Object.fromEntries(Object.entries(second).map(([k, v]) => [k, v[0]!])),
      })
      const fs = judgmentScores(first)
      const ss = judgmentScores(second)
      firstScores.push(names.map((n) => fs[n] ?? 0))
      secondScores.push(names.map((n) => ss[n] ?? 0))
    } catch (err) {
      if (err instanceof ScoreParseError) continue // count as failed repeat
      throw err
    }
  }

  if (firstScores.length === 0 || secondScores.length === 0) {
    throw new ScoreParseError('all scoring repeats failed to produce valid JSON', raw.join('\n---\n'))
  }
  const avg = (rows: number[][]) => names.map((_, c) => mean(rows.map((row) => row[c]!)))
  const fAvg = avg(firstScores)
  const sAvg = avg(secondScores)
  const fSpread = stdev(firstScores.map((row) => mean(row)))
  const sSpread = stdev(secondScores.map((row) => mean(row)))
  return {
    scores: [mean(fAvg), mean(sAvg)],
    spreads: [fSpread, sSpread],
    perRepeat,
    failures: repeats - perRepeat.length,
    raw,
  }
}
