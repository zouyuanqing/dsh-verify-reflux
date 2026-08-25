import test from 'node:test'
import assert from 'node:assert/strict'
import { extractScoreLetter, makeSamplingJudge, createCapabilityStore } from '../src/judges.js'
import type { LlmStreamService } from '../src/llm.js'

test('extractScoreLetter tolerates spacing, fullwidth colon and case', () => {
  assert.equal(extractScoreLetter('SCORE:D'), 'D')
  assert.equal(extractScoreLetter('score： e'), 'E')
  assert.equal(extractScoreLetter('SCORE:(T).'), 'T')
  assert.equal(extractScoreLetter('The grade is bad'), null)
  // U is outside the A-T scale — must not match.
  assert.equal(extractScoreLetter('SCORE:U'), null)
})

/** Scripted llm: pops canned replies in order for every completion. */
function scriptedLlm(replies: string[]): LlmStreamService & { prompts: string[] } {
  let i = 0
  return {
    prompts: [],
    async *stream(options) {
      const block = options.messages?.[0]?.content?.[0] as { text?: string } | undefined
      this.prompts.push(String(block?.text ?? ''))
      const text = replies[Math.min(i, replies.length - 1)]!
      i++
      yield { type: 'text-delta', text }
    },
  }
}

test('sampling judge converts letter frequencies into a distribution', async () => {
  const llm = scriptedLlm(['SCORE:B', 'noise', 'SCORE:C', 'SCORE:B'])
  const judge = makeSamplingJudge(llm, { provider: 'p', model: 'm' }, { system: 's', samples: 4 })
  const { dist, raw } = await judge.dist({ problem: 't', candidate: 'c', criterion: 'Correctness: works' })
  // Laplace smoothing keeps every letter alive (no hard zeros); the two
  // untouched extremes carry exactly the prior mass.
  assert.equal(dist.filter((p) => p > 0).length, 20)
  assert.ok(Math.abs(dist[0]! - dist[19]!) < 1e-12, 'symmetric prior on untouched edges')
  // Laplace α=0.5: B count 2.5, C 1.5, others 0.5 → total 20·0.5 + extra hits
  const total = dist.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 1) < 1e-9)
  assert.ok(dist[1]! > dist[2]!, 'B must outrank C')
  assert.ok(dist[1]! < 0.5, `B mass ${dist[1]} kept honest by smoothing`)
  assert.ok(raw.includes('noise'), 'unparsable samples are preserved in raw trace')
})

test('sampling judge throws when nothing parses', async () => {
  const llm = scriptedLlm(['garbage one'])
  const judge = makeSamplingJudge(llm, { provider: 'p', model: 'm' }, { system: 's', samples: 1 })
  await assert.rejects(judge.dist({ problem: 't', candidate: 'c', criterion: 'x' }), /no parsable SCORE/)
})

test('capability store honors cooldown semantics', () => {
  const store = createCapabilityStore()
  assert.equal(store.get('a'), undefined)
  store.set('a', true)
  assert.equal(store.get('a'), true)
  store.set('b', false)
  assert.equal(store.get('b'), false, 'within cooldown a failed endpoint stays dark')
})
