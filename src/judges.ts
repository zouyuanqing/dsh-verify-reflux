/**
 * 判分器阶梯与能力缓存：同一套绝对评分接口，按保真度自动降级。
 *
 * T1 logprob —— 直连端点的真 token 分布（论文原机制），需配置且探测通过；
 * T2 sample —— 会话模型同题采样，频次即概率（对所有 ctx.llm 路由可用）；
 * T3 template —— 单次补全众数+置信模板（原模板档）。
 *
 * 能力探测结果持久化到 .verifier/capabilities.json：失败的端点记冷却期，
 * 冷却期内不再浪费请求，冷却后自动复探。
 */

import { LETTERS } from './scale.js'
import { completeText } from './llm.js'
import type { LlmStreamService } from './llm.js'

export type Tier = 'logprob' | 'sample' | 'template'

/** 一个判分器：给定单条标准 + 候选，返回归一化的 20 维字母分布。 */
export interface DistributionJudge {
  tier: Tier
  /** 稳定的来源标签，进轨迹与回流 provenance（如 logprob@api.deepseek.com/deepseek-chat）。 */
  via: string
  dist(args: { problem: string; candidate: string; criterion: string; signal?: AbortSignal }): Promise<{
    dist: number[]
    raw: string
  }>
}

/** 绝对评分提示词；视角按调用轮转制造重评独立性（与直连档同源）。 */
const STANCES = [
  'a correctness engineer hunting for logic errors',
  'a security auditor probing for exploitable flaws',
  'a performance engineer watching for pathological costs',
]
let stanceCounter = 0
export function absolutePrompt(problem: string, criterion: string, candidate: string): string {
  const stance = STANCES[stanceCounter++ % STANCES.length]
  return [
    `## Task\n${problem.slice(0, 800)}`,
    `## Criterion\n${criterion}`,
    `## Reviewer stance\n${stance}`,
    `## Solution\n${candidate.slice(0, 1500)}`,
    'Grade ONLY this criterion. Reply ONLY: SCORE:X',
  ].join('\n\n')
}

const SCORE_RE = /['"]?SCORE['"]?\s*[:：]\s*\(?\s*['"]?([A-T])\b/i

/** 从一段模型文本里提取 SCORE:<letter>；提取不到返回 null。 */
export function extractScoreLetter(text: string): string | null {
  const m = text.match(SCORE_RE)
  return m ? m[1]!.toUpperCase() : null
}

/**
 * T2：同题独立采样 S 次（温度>0 制造多样性），把字母频次当作概率估计。
 * 加性平滑（α=0.5）避免零概率把相邻档位一刀切死。样本即论文的
 * repeated-evaluation 轴：频次收敛于真实输出分布。
 */
export function makeSamplingJudge(
  llm: LlmStreamService,
  route: { provider: string; model: string },
  defaults: { system: string; samples?: number; temperature?: number },
): DistributionJudge {
  return {
    tier: 'sample',
    via: `sample@${route.provider}/${route.model}`,
    async dist({ problem, candidate, criterion, signal }) {
      const prompt = absolutePrompt(problem, criterion, candidate)
      const alpha = 0.5
      const counts = new Array<number>(LETTERS.length).fill(alpha)
      const raw: string[] = []
      let hits = 0
      for (let s = 0; s < Math.max(1, defaults.samples ?? 6); s++) {
        signal?.throwIfAborted()
        let text: string
        try {
          text = await completeText(llm, {
            ...route,
            system: defaults.system,
            prompt,
            maxTokens: 4096,
            signal,
          })
        } catch (err) {
          if (signal?.aborted) throw err
          raw.push(`sample ${s}: transport failure ${String(err)}`)
          continue
        }
        raw.push(text)
        // 提示词里带轮换视角占位时由调用方替换；这里只认 SCORE:X。
        const letter = extractScoreLetter(text)
        if (!letter) continue
        counts[LETTERS.indexOf(letter)]! += 1
        hits++
      }
      if (hits === 0) throw new Error('sampling judge produced no parsable SCORE')
      const total = counts.reduce((a, b) => a + b, 0)
      return { dist: counts.map((c) => c / total), raw: raw.join('\n---\n') }
    },
  }
}

/* ---------- 能力缓存 ---------- */

export interface CapabilityStore {
  get(key: string): boolean | undefined
  set(key: string, ok: boolean): void
}

interface CapFile {
  [endpointKey: string]: { ok: boolean; at: number }
}

const COOLDOWN_MS = 60 * 60 * 1000

/** 内存态即可满足降级语义；落盘留给未来跨会话复用（v2.1）。 */
export function createCapabilityStore(): CapabilityStore {
  const mem: CapFile = {}
  return {
    get(key) {
      const hit = mem[key]
      if (!hit) return undefined
      if (!hit.ok && Date.now() - hit.at < COOLDOWN_MS) return false
      if (!hit.ok) return undefined // 冷却已过 → 允许复探
      return true
    },
    set(key, ok) {
      mem[key] = { ok, at: Date.now() }
    },
  }
}

/** 探测一个直连端点是否真返回 logprobs（一次极小请求）。 */
export async function probeLogprobs(
  endpoint: { baseUrl: string; apiKey: string; model: string },
  fetchImpl: FetchLike,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${endpoint.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: 'user', content: 'Reply ONLY: SCORE:B' }],
        max_tokens: 12,
        temperature: 0,
        logprobs: true,
        top_logprobs: 8,
      }),
    })
    if (!res.ok) return false
    const json = (await res.json()) as { choices?: Array<{ logprobs?: { content?: unknown[] } }> }
    return Boolean(json.choices?.[0]?.logprobs?.content?.length)
  } catch {
    return false
  }
}

export interface FetchLike {
  (url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
    text(): Promise<string>
  }>
}
