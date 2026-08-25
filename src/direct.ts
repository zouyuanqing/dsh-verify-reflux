/**
 * 直连档：OpenAI 兼容端点（实测 DeepSeek 官方 API ✓）的 token 级分布评分。
 *
 * 这是论文 LLM-as-a-Verifier 的原教旨机制：让模型输出 SCORE:<letter>，
 * 读取该字母位置 top_logprobs 中落在 A–T 刻度上的质量并归一化，
 * 对 20 级刻度取期望。与模板档不同，这里的分布是模型内部不确定性的
 * 直接读数，而非文本自报的二手估计。
 */

export interface DirectEndpoint {
  baseUrl: string
  apiKey: string
  model: string
}

export interface DirectScoreResult {
  /** 归一化到和为 1 的 20 维字母分布（A=下标0 … T=下标19）。 */
  dist: number[]
  /** 内容里实际采到的众数字母。 */
  letter: string
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRST'

export class DirectScoreError extends Error {
  constructor(
    message: string,
    readonly raw?: string,
  ) {
    super(message)
    this.name = 'DirectScoreError'
  }
}

/** OpenAI 风格 chat/completions 响应中一条 logprob 记录的最小切片。 */
interface LogprobEntry {
  token: string
  logprob: number
  top_logprobs?: Array<{ token: string; logprob: number }>
}

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    text(): Promise<string>
  }>
}

/**
 * 单次绝对评分：返回该候选在某评价标准下的完整字母分布。
 * 提示词要求 `SCORE:X`；解析内容 token 序列，找到首个剥掉空白后恰为
 * 单个 A–T 字母的 token，聚合其 top_logprobs 里所有单字母 token 的质量。
 */
export async function scoreDirect(
  endpoint: DirectEndpoint,
  args: { system: string; prompt: string; maxTokens?: number; signal?: AbortSignal },
  fetchImpl: FetchLike,
): Promise<DirectScoreResult> {
  const res = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${endpoint.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: endpoint.model,
      messages: [
        ...(args.system ? [{ role: 'system', content: args.system }] : []),
        { role: 'user', content: args.prompt },
      ],
      max_tokens: args.maxTokens ?? 16,
      temperature: 0,
      logprobs: true,
      top_logprobs: 20,
    }),
  })
  if (!res.ok) throw new DirectScoreError(`endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; logprobs?: { content?: LogprobEntry[] } }>
  }
  const choice = json.choices?.[0]
  const entries = choice?.logprobs?.content ?? []
  const content = choice?.message?.content ?? ''
  void content

  // 找第一个"裸字母"决策点：token 本身（去空白/标点后）是单个 A–T。
  for (const entry of entries) {
    const bare = entry.token.trim().replace(/[^A-Za-z]/g, '')
    if (bare.length !== 1 || !LETTERS.includes(bare.toUpperCase())) continue
    const upper = bare.toUpperCase()
    // 决策分布：该位置 top_logprobs 中的单字母候选，按指数概率归一化。
    const mass = new Map<number, number>()
    let total = 0
    for (const cand of entry.top_logprobs ?? []) {
      const c = cand.token.trim().replace(/[^A-Za-z]/g, '')
      if (c.length !== 1) continue
      const idx = LETTERS.indexOf(c.toUpperCase())
      if (idx < 0) continue
      const p = Math.exp(cand.logprob)
      mass.set(idx, (mass.get(idx) ?? 0) + p)
      total += p
    }
    if (total <= 0) continue
    const dist = new Array<number>(LETTERS.length).fill(0)
    for (const [idx, p] of mass) dist[idx] = p / total
    return { dist, letter: upper }
  }
  throw new DirectScoreError('no bare-letter decision token found', JSON.stringify(entries.slice(0, 4)))
}

/** 分布期望值 ∈ [0,1]。 */
export function expectationOf(dist: number[]): number {
  let acc = 0
  for (let i = 0; i < dist.length; i++) acc += (dist[i] ?? 0) * (i / (dist.length - 1))
  return acc
}
