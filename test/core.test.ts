import test from 'node:test'
import assert from 'node:assert/strict'
import { templateDist, judgeScore, expectation, isLetter, mean, stdev } from '../src/scale.js'
import { createRng, shuffled } from '../src/rng.js'
import { formatSelectReflux, formatCheckReflux, formatTrackLine } from '../src/reflux.js'
import { createTraceSink } from '../src/trace.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('templateDist sums to 1 and clamps at scale edges', () => {
  for (const letter of ['A', 'G', 'T'] as const) {
    for (const conf of ['high', 'medium', 'low'] as const) {
      const dist = templateDist(letter, conf)
      const total = dist.reduce((a, b) => a + b, 0)
      assert.ok(Math.abs(total - 1) < 1e-9, `${letter}/${conf} sums to ${total}`)
      assert.equal(dist.length, 20)
    }
  }
  // Edge mode A loses its negative offsets; remaining mass renormalizes upward.
  const a = templateDist('A', 'high')
  assert.equal(a[19], 0)
  assert.ok(a[0]! > 0.7, 'edge mass concentrates on mode after renormalization')
})

test('judgeScore maps letters monotonically onto [0,1]', () => {
  const scores = (['A', 'E', 'J', 'O', 'T'] as const).map((l) => judgeScore(l, 'medium'))
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i]! > scores[i - 1]!, `score must increase: ${scores[i - 1]} !< ${scores[i]}`)
  }
  assert.ok(scores[0]! >= 0 && scores.at(-1)! <= 1)
})

test('expectation of uniform distribution is the midpoint', () => {
  const mid = expectation(new Array(20).fill(1 / 20))
  assert.ok(Math.abs(mid - 0.5) < 1e-9)
})

test('isLetter accepts single A-T only', () => {
  assert.equal(isLetter('A'), true)
  assert.equal(isLetter('T'), true)
  assert.equal(isLetter('U'), false)
  assert.equal(isLetter('AB'), false)
  assert.equal(isLetter(7), false)
})

test('mean/stdev basics', () => {
  assert.equal(mean([2, 4]), 3)
  assert.ok(stdev([1, 1, 1]) === 0)
  assert.ok(stdev([5]) === 0)
  assert.ok(stdev([1, 3]) > 1.4 && stdev([1, 3]) < 1.42)
})

test('seeded rng replays identically across instances', () => {
  const a = [...Array(10)].map(() => createRng(42)())
  const b = [...Array(10)].map(() => createRng(42)())
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, [...Array(10)].map(() => createRng(43)()))
})

test('shuffled is a permutation driven by the rng', () => {
  const rng = createRng(7)
  const out = shuffled([0, 1, 2, 3, 4, 5], rng)
  assert.deepEqual([...out].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5])
})

const META = {
  tool: 'verify_select',
  provider: 'openrouter',
  model: 'stealth/ox-alpha',
  seed: 42,
  margin: 0.04,
  tracesPath: '.verifier/traces/x.md',
}

test('select reflux block carries provenance and three sections', () => {
  const out = formatSelectReflux({
    meta: META,
    bestLabel: 'Best: candidate 1',
    best: 'def add(a,b){return a+b}',
    scoresLine: 'score 0.720 vs 0.580; 6 comparisons',
    record: '① x\n② y\n③ z',
  })
  assert.ok(out.startsWith('Best: candidate 1 | score'))
  assert.ok(out.includes('<verified_decision tool="verify_select" model="openrouter/stealth/ox-alpha" seed="42" margin="0.040" traces=".verifier/traces/x.md">'))
  assert.ok(out.includes('① x\n② y\n③ z'))
  assert.ok(out.includes('</verified_decision>'))
})

test('check reflux block formats risk map', () => {
  const out = formatCheckReflux({ meta: { ...META, tracesPath: 't.md' }, scoresLine: 's', record: '①a\n②b\n③c' })
  assert.ok(out.includes('tool="verify_check"'))
})

test('track line flags stall only when asked', () => {
  const pts = [{ step: 1, value: 0.2 }, { step: 2, value: 0.21 }, { step: 3, value: 0.22 }]
  assert.ok(formatTrackLine(pts, true).includes('⚠️'))
  assert.ok(!formatTrackLine(pts, false).includes('⚠️'))
  assert.ok(formatTrackLine(pts, false).includes('1:20% → 2:21% → 3:22%'))
})

test('trace sink writes files and caps graveyard at 10', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-reflux-'))
  const sink = createTraceSink(dir)
  const rel = await sink.writeTrace('select.md', 'hello trace')
  assert.ok(rel.startsWith('.verifier/traces/') && rel.endsWith('.md'))
  for (let i = 0; i < 12; i++) await sink.appendGraveyard(`entry-${i}`)
  const tail = await sink.graveyardTail(10)
  assert.equal(tail.length, 10)
  assert.ok(tail[0]!.includes('entry-2'))
  assert.ok(tail.at(-1)!.includes('entry-11'))
})
