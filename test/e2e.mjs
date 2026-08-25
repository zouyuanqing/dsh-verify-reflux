/**
 * End-to-end smoke: drives the compiled plugin's apply() with a recording
 * mock context and a scripted LLM stream, executing verify_select fully —
 * tournament, distillation, reflux formatting, trace persistence.
 */
import { apply } from '../lib/index.js'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

const JUDGE = JSON.stringify({
  A: { Correctness: ['D', 'medium'], Safety: ['C', 'high'] },
  B: { Correctness: ['J', 'high'], Safety: ['H', 'medium'] },
})

const llmCalls = []
const llm = {
  calls: 0,
  sampleCursor: 0,
  async *stream(options) {
    llmCalls.push(options)
    this.calls++
    const systemText = String(options.system ?? '')
    // Sampling tier: absolute SCORE:X protocol — broken candidate grades
    // low, guarded one grades high; letters cycle to exercise the
    // frequency→distribution aggregation.
    if (systemText.includes('SCORE:X')) {
      const promptText = String(options.messages?.[0]?.content?.[0]?.text ?? '')
      const low = promptText.includes('a-b')
      const letters = low ? ['A', 'B', 'A'] : ['J', 'K', 'J']
      yield { type: 'text-delta', text: `SCORE:${letters[this.sampleCursor++ % letters.length]}` }
      return
    }
    // Legacy pairwise JSON vs distillation record.
    const isJudge = systemText.includes('reviewer grading candidate')
    const text = isJudge
      ? JUDGE
      : '① DECISIVE: B guards both failure modes with input validation\n② REJECTED: A subtracts instead of adding\n③ NEAR-TIE: none'
    yield { type: 'text-delta', text }
  },
  listProviders() {
    return [{ id: 'test-route' }]
  },
  listModels(provider) {
    return [{ id: provider === 'test-route' ? 'mock-model' : undefined }]
  },
}

const registeredTools = new Map()
const systemSections = []
const systemContexts = []
const ctx = {
  tools: {
    register(tool) {
      registeredTools.set(tool.name, tool)
    },
  },
  systemPrompt: {
    section(entry) {
      systemSections.push(entry)
    },
    context(entry) {
      systemContexts.push(entry)
    },
  },
  llm,
}

process.chdir(mkdtempSync(join(tmpdir(), 'verify-reflux-e2e-')))
apply(ctx, {})

assert.ok(registeredTools.has('verify_select'), 'select registered')
assert.ok(registeredTools.has('verify_check'), 'check registered')
assert.ok(registeredTools.has('verify_track'), 'track registered')
assert.equal(systemSections.length, 1)
assert.match(systemSections[0].text, /graveyard/)

const tool = registeredTools.get('verify_select')
const result = await tool.execute(
  {
    problem: 'implement add(a,b)',
    candidates: [
      'def add(a,b): return a-b',
      'def add(a,b):\n    if not all(isinstance(x,(int,float)) for x in (a,b)): raise TypeError\n    return a+b',
    ],
    criteria: { Correctness: 'adds numbers', Safety: 'rejects bad input' },
    seed: 42,
    pivots: 2,
    repeats: 2,
  },
  { signal: undefined },
)

// L1 verdict line names the true winner.
assert.match(result.reflux, /^Best: candidate 1 \| score/)
const stateText = systemContexts.find((c) => c.name === 'verify-reflux:state').text()
assert.match(stateText, /candidate 2 wins/, 'verified-state snapshot carries the verdict')
assert.match(stateText, /\(sample@test-route\/mock-model\)/, 'snapshot keeps tier provenance')
// Sample tier served this verdict: absolute scoring means zero pairwise comparisons.
assert.match(result.reflux, /0 comparisons/)
// L2 block carries provenance and the distilled three sections.
assert.match(result.reflux, /<verified_decision tool="verify_select" model="test-route\/mock-model" via="sample@test-route\/mock-model" seed="42"/)
assert.match(result.reflux, /① DECISIVE/)
assert.match(result.reflux, /② REJECTED/)
assert.match(result.reflux, /③ NEAR-TIE/)
assert.equal(result.winnerIndex, 1)
assert.ok(result.scores['1'] > result.scores['0'])

// Presentation plane: full traces on disk, never in the reflux text.
const traceFile = result.reflux.match(/traces="([^"]+)"/)[1]
const trace = await readFile(traceFile.replace(/^\.verifier/, '.verifier'), 'utf8')
assert.ok(trace.includes('# verify_select'))
assert.ok(trace.includes('## decision record'))
assert.ok(!result.reflux.includes('candidate-A-body'), 'raw candidate bodies stay out of context')

console.log('E2E OK — reflux block:')
console.log(result.reflux)
