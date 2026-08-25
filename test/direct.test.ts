import test from 'node:test'
import assert from 'node:assert/strict'
import { scoreDirect, expectationOf, DirectScoreError } from '../src/direct.js'
import type { FetchLike } from '../src/direct.js'

/** OpenAI-style payload builder: content tokens + per-token top_logprobs. */
function payload(tokens: Array<{ token: string; top?: Array<[string, number]> }>) {
  return {
    choices: [
      {
        message: { content: tokens.map((t) => t.token).join('') },
        logprobs: {
          content: tokens.map((t) => ({
            token: t.token,
            logprob: -0.1,
            top_logprobs: (t.top ?? []).map(([tok, lp]) => ({ token: tok, logprob: lp })),
          })),
        },
      },
    ],
  }
}

function okFetch(payloadBody: unknown): FetchLike {
  return async (url, init) => ({ ok: true, status: 200, json: async () => payloadBody, text: async () => '' })
}

test('scoreDirect extracts letter distribution at the decision token', async () => {
  const calls: Array<{ url: string; body: string }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body })
    return await okFetch(
      payload([
        { token: 'SCORE' },
        { token: ':' },
        {
          token: 'D',
          top: [
            ['D', -0.2],
            ['E', -2.5],
            ['C', -4.0],
            ['good', -6.0], // non-letter must be ignored
          ],
        },
      ]),
    )(url, init)
  }
  const r = await scoreDirect({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, { system: 's', prompt: 'p' }, fetchImpl)
  assert.equal(r.letter, 'D')
  // exp(-0.2)=0.8187, exp(-2.5)=0.0821, exp(-4)=0.0183 → D mass ≈ 0.892
  assert.ok(r.dist[3]! > 0.85 && r.dist[3]! < 0.95, `D mass ${r.dist[3]}`)
  assert.equal(r.dist.filter((p) => p > 0).length, 3)
  const total = r.dist.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 1) < 1e-9)
  // Request shape carries logprobs request.
  const sent = JSON.parse(calls[0]!.body)
  assert.equal(sent.logprobs, true)
  assert.equal(sent.top_logprobs, 20)
})

test('expectationOf midpoint and edges', () => {
  assert.ok(Math.abs(expectationOf(new Array(20).fill(1 / 20)) - 0.5) < 1e-9)
  const allA = new Array(20).fill(0)
  allA[0] = 1
  assert.equal(expectationOf(allA), 0)
  const allT = new Array(20).fill(0)
  allT[19] = 1
  assert.equal(expectationOf(allT), 1)
})

test('no bare-letter token → DirectScoreError', async () => {
  const fetchImpl: FetchLike = okFetch(payload([{ token: 'The' }, { token: ' grade' }, { token: ' is' }, { token: ' bad' }]))
  await assert.rejects(
    scoreDirect({ baseUrl: 'https://x', apiKey: 'k', model: 'm' }, { system: '', prompt: '' }, fetchImpl),
    DirectScoreError,
  )
})

test('http failure surfaces as DirectScoreError with status', async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: false,
    status: 401,
    json: async () => ({}),
    text: async () => '{"error":"bad key"}',
  })
  await assert.rejects(scoreDirect({ baseUrl: 'https://x', apiKey: 'k', model: 'm' }, { system: '', prompt: '' }, fetchImpl), /401/)
})
