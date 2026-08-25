import { completeText } from './llm.js'
import type { LlmStreamService } from './llm.js'

/**
 * L2 决胜链蒸馏：把锦标赛的裁决压缩成 ≤200 token 的三段式结构化回注。
 *
 * 蒸馏规则（DESIGN.md）：必须保留 ①决胜约束（≤2 条，含技术细节）
 * ②否决记录（每个落选者一句话死因）③险胜边际（差距 <0.05 的标准）。
 * 压缩丢掉"恰好让它赢的那条约束"是最大风险，因此三段皆为硬性产出。
 */

const DISTILL_SYSTEM =
  'You compress verification verdicts into decision records. Output EXACTLY three lines, ' +
  'no prose before or after, each line at most 40 words:\n' +
  '① DECISIVE: why the winner won — at most 2 constraints with concrete technical detail\n' +
  '② REJECTED: one clause per loser naming its specific cause of death\n' +
  '③ NEAR-TIE: criteria whose score gap was <0.05, or "none"\n' +
  'Format: "① …\\n② …\\n③ …"'

export interface DistillInput {
  problem: string
  criteria: Record<string, string>
  winnerIndex: number
  winnerBody: string
  losers: Array<{ index: number; body: string; score: number }>
  winnerScore: number
  runnerUpScore: number
  route: { provider: string; model: string }
  signal?: AbortSignal
}

/** Run the distillation completion; returns the raw three-line record. */
export async function distillVerdict(llm: LlmStreamService, input: DistillInput): Promise<string> {
  const criterionLine = Object.entries(input.criteria)
    .map(([name]) => name)
    .join(', ')
  const loserLines = input.losers
    .map((l) => `- candidate ${l.index} (score ${l.score.toFixed(3)}): ${truncate(l.body, 600)}`)
    .join('\n')
  const prompt = [
    `## Problem\n${truncate(input.problem, 800)}`,
    `## Criteria scored\n${criterionLine}`,
    `## Winner — candidate ${input.winnerIndex} (score ${input.winnerScore.toFixed(3)}, runner-up ${input.runnerUpScore.toFixed(3)})\n${truncate(input.winnerBody, 2000)}`,
    `## Losers\n${loserLines || 'none'}`,
    'Compress this verdict into the exact three-line record. Preserve the concrete technical reason the winner wins.',
  ].join('\n\n')
  return completeText(llm, {
    ...input.route,
    system: DISTILL_SYSTEM,
    prompt,
    temperature: 0,
    maxTokens: 300,
    signal: input.signal,
  })
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`
}

/** Sanity-check the distilled record has all three sections; else fall back. */
export function isValidRecord(record: string): boolean {
  return record.includes('①') && record.includes('②') && record.includes('③')
}
