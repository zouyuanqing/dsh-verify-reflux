import { createRng, shuffled } from './rng.js'

/**
 * Seeded pivot tournament with a connecting chain pass.
 *
 * A seeded shuffle defines a chain (N−1 comparisons) plus k pivots that every
 * other candidate meets once — N−1 + k·(N−k) directed comparisons instead of
 * O(N²). The chain guarantees every candidate shares results with neighbors,
 * so identical pivot sets cannot mask quality differences; preferences
 * aggregate through Bradley-Terry fitting into continuous scores with margins.
 */

/** Logistic preference of a over b from two [0,1] scores; steepness 12 ≈ decisive at Δ≥0.25. */
export function preference(scoreA: number, scoreB: number): number {
  return 1 / (1 + Math.exp(-(scoreA - scoreB) * 12))
}

/**
 * Bradley-Terry strength fitting over fractional pairwise preferences
 * (Zermelo fixed-point iteration).
 *
 * Mean-of-preferences ignores opponent identity: two undefeated candidates
 * with identical degree tie exactly, however different their victims were.
 * BT propagates strength along chains — A beat B beat C lifts A above B even
 * where raw win-rates coincide. Fractional prefs enter as expected wins;
 * strengths are normalized (geometric mean 1) then squashed into [0, 1].
 */
export function bradleyTerry(wins: Array<Array<{ opponent: number; pref: number }>>): number[] {
  const n = wins.length
  const totals = wins.map((list) => list.reduce((acc, w) => acc + w.pref, 0))
  const gamma = new Array<number>(n).fill(1)
  for (let iter = 0; iter < 64; iter++) {
    const next = gamma.map((g, i) => {
      let denom = 0
      for (const { opponent } of wins[i]!) denom += 1 / (g + Math.max(gamma[opponent]!, 1e-9))
      return denom === 0 ? g : totals[i]! / denom
    })
    let logSum = 0
    for (let i = 0; i < n; i++) {
      next[i] = Math.max(next[i]!, 1e-9)
      logSum += Math.log(next[i]!)
    }
    const norm = Math.exp(logSum / n)
    for (let i = 0; i < n; i++) gamma[i] = next[i]! / norm
  }
  return gamma.map((g) => (Number.isFinite(g) ? g / (1 + g) : 0.5))
}

export interface TournamentResult {
  /** Candidate indices sorted best-first. */
  ranking: number[]
  /** Continuous aggregate score per candidate index. */
  scores: number[]
  winner: number
  runnerUp: number
  nComparisons: number
}

/**
 * Rank N candidates. `compare(i, j)` returns a PairwiseResult-like pair of
 * scores from candidate i's perspective vs j. Identical inputs with the same
 * seed replay identically; different seeds reshuffle pivots and order.
 */
export async function runTournament<T>(args: {
  candidates: readonly T[]
  pivots: number
  seed: number
  signal?: AbortSignal
  compare: (i: number, j: number) => Promise<[number, number]>
}): Promise<TournamentResult> {
  const n = args.candidates.length
  if (n === 0) throw new Error('no candidates to rank')
  if (n === 1) return { ranking: [0], scores: [Number.NaN], winner: 0, runnerUp: 0, nComparisons: 0 }

  const rng = createRng(args.seed)
  const order = shuffled([...Array(n).keys()], rng)
  const k = Math.min(Math.max(1, args.pivots), n - 1)
  const pivotSet = new Set(order.slice(0, k))
  const rest = order.slice(k)

  // Directed comparisons: each non-pivot vs each pivot.
  const wins: Array<Array<{ opponent: number; pref: number }>> = [...Array(n)].map(() => [])
  let nComparisons = 0

  // Chain pass over the shuffled order connects candidates that share no
  // pivot results; without it, non-pivots meeting only identical pivot sets
  // are indistinguishable no matter how different their quality (observed:
  // four-way tie at the top under a weak-pivot seed). A chain (n−1 edges)
  // suffices for connectivity; wrapping into a cycle would duplicate the
  // single pair when n=2.
  for (let i = 0; i + 1 < n; i++) {
    args.signal?.throwIfAborted()
    const a = order[i]!
    const b = order[i + 1]!
    const [sa, sb] = await args.compare(a, b)
    wins[a]!.push({ opponent: b, pref: preference(sa!, sb!) })
    wins[b]!.push({ opponent: a, pref: preference(sb!, sa!) })
    nComparisons++
  }

  for (const cand of rest) {
    for (const pivot of pivotSet) {
      if (pivot === cand) continue
      args.signal?.throwIfAborted()
      // Alternate direction so neither role always sits in slot A.
      const [sCand, sPivot] =
        (cand + pivot) % 2 === 0
          ? await args.compare(cand, pivot)
          : (([sP, sC]) => [sC, sP])(await args.compare(pivot, cand))
      wins[cand]!.push({ opponent: pivot, pref: preference(sCand!, sPivot!) })
      wins[pivot]!.push({ opponent: cand, pref: preference(sPivot!, sCand!) })
      nComparisons++
    }
  }
  // Pivots never met each other: neutral edges keep their means comparable
  // until ranking separates them through shared opponents.
  for (const p of pivotSet) {
    for (const q of pivotSet) {
      if (p === q) continue
      wins[p]!.push({ opponent: q, pref: 0.5 })
    }
  }

  const scores = bradleyTerry(wins)
  const ranking = [...Array(n).keys()].sort((a, b) => scores[b]! - scores[a]! || a - b)
  return {
    ranking,
    scores,
    winner: ranking[0]!,
    runnerUp: ranking[1]!,
    nComparisons,
  }
}
