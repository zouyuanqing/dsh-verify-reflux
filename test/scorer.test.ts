import test from 'node:test'
import assert from 'node:assert/strict'
import { extractJson, ScoreParseError, comparePair } from '../src/scorer.js'
import type { LlmStreamService } from '../src/llm.js'

test('extractJson tolerates prose, fences and trailing commentary', () => {
  const obj = extractJson('Sure! ```json\n{"A":{"Correctness":["F","high"]}}\n``` hope that helps')
  assert.deepEqual(obj, { A: { Correctness: ['F', 'high'] } })
  const nested = extractJson('{"outer":{"inner":[1,2]},"trailing":"}" }')
  assert.deepEqual(nested, { outer: { inner: [1, 2] }, trailing: '}' })
})

test('extractJson rejects non-JSON and unbalanced objects', () => {
  assert.throws(() => extractJson('no braces here'), ScoreParseError)
  assert.throws(() => extractJson('{"broken": '), ScoreParseError)
  // Braces inside strings must not confuse the scanner.
  const ok = extractJson('{"note":"has } brace","x":1}')
  assert.deepEqual(ok, { note: 'has } brace', x: 1 })
})

/** Mock harness stream: pops one canned response per completion. */
function mockLlm(responses: string[]): LlmStreamService & { calls: number } {
  let i = 0
  return {
    calls: 0,
    async *stream() {
      const text = responses[Math.min(i, responses.length - 1)]!
      i++
      this.calls++
      yield { type: 'text-delta', text }
    },
  }
}

const CRITERIA = { Correctness: 'does it work', Safety: 'no crashes' }

const VALID = {
  A: { Correctness: ['D', 'medium'], Safety: ['C', 'high'] },
  B: { Correctness: ['J', 'high'], Safety: ['H', 'medium'] },
}
const validText = JSON.stringify(VALID)

test('comparePair aggregates repeats and un-swaps presentation order', async () => {
  // The model judges by BODY content, so a faithful response is identical in
  // both presentation orders; un-swapping must still attribute scores to the
  // same candidates.
  const llm = mockLlm([validText, validText])
  const result = await comparePair(
    llm,
    { provider: 't', model: 'm' },
    'problem',
    'candidate-A-body',
    'candidate-B-body',
    CRITERIA,
    { repeats: 2 },
  )
  assert.equal(llm.calls, 2)
  assert.equal(result.failures, 0)
  // Candidate A scored low in BOTH repeats despite the second being presented swapped.
  assert.ok(result.scores[0]! < 0.35, `A score ${result.scores[0]}`)
  assert.ok(result.scores[1]! > 0.40, `B score ${result.scores[1]}`)
  assert.equal(result.perRepeat.length, 2)
  // Both repeats agree per candidate after un-swapping.
  assert.deepEqual(result.perRepeat[0]!.first, result.perRepeat[1]!.first)
  assert.deepEqual(result.perRepeat[0]!.second, result.perRepeat[1]!.second)
  assert.ok(result.perRepeat.length === 2)
})

test('comparePair counts malformed repeats as failures and throws when all fail', async () => {
  const llm = mockLlm(['total garbage'])
  await assert.rejects(
    comparePair(llm, { provider: 't', model: 'm' }, 'p', 'a', 'b', CRITERIA, { repeats: 1 }),
    ScoreParseError,
  )
})

test('comparePair tolerates criterion key casing drift', async () => {
  const drifted = JSON.stringify({
    A: { correctness: ['K', 'low'], ' SAFETY ': ['M', 'low'] },
    B: { Correctness: ['L', 'low'], Safety: ['N', 'low'] },
  })
  const llm = mockLlm([drifted])
  const result = await comparePair(llm, { provider: 't', model: 'm' }, 'p', 'a', 'b', CRITERIA, { repeats: 1 })
  assert.equal(result.failures, 0)
})
