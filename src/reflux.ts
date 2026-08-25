/**
 * 回流格式化。红线：呈现层可仿思维链样式，上下文不可伪出处——
 * L2 一律是带 provenance 的结构化块，绝不伪装成主模型自己的 reasoning。
 */

export interface RefluxMeta {
  tool: string
  /** 判分来源标签（logprob@… / sample@…），缺省为模板档。 */
  via?: string
  provider: string
  model: string
  seed?: number
  margin?: number
  tracesPath?: string
  graveyardPath?: string
  stalled?: boolean
}

/** L1 结论行 + L2 决胜链块。render() 的输出即进入上下文的全部内容。 */
export function formatSelectReflux(args: {
  meta: RefluxMeta
  bestLabel: string
  best: string
  scoresLine: string
  record: string
}): string {
  const m = args.meta
  const attrs = [
    `tool="${m.tool}"`,
    `model="${m.provider}/${m.model}"`,
    m.via ? `via="${m.via}"` : null,
    m.seed !== undefined ? `seed="${m.seed}"` : null,
    m.margin !== undefined ? `margin="${m.margin.toFixed(3)}"` : null,
    m.tracesPath ? `traces="${m.tracesPath}"` : null,
    m.graveyardPath ? `graveyard="${m.graveyardPath}"` : null,
  ]
    .filter(Boolean)
    .join(' ')
  return [
    `${args.bestLabel} | ${args.scoresLine}`,
    `<verified_decision ${attrs}>`,
    args.record.trim(),
    '</verified_decision>',
  ].join('\n')
}

/** verify_check 的风险地图回流块。 */
export function formatCheckReflux(args: {
  meta: RefluxMeta
  scoresLine: string
  record: string
}): string {
  const m = args.meta
  const attrs = [
    `tool="verify_check"`,
    `model="${m.provider}/${m.model}"`,
    m.via ? `via="${m.via}"` : null,
    m.tracesPath ? `traces="${m.tracesPath}"` : null,
  ]
    .filter(Boolean)
    .join(' ')
  return [args.scoresLine, `<verified_decision ${attrs}>`, args.record.trim(), '</verified_decision>'].join(
    '\n',
  )
}

/** verify_track 的进度曲线行；连续停滞时附 ⚠️ 换路建议。 */
export function formatTrackLine(scores: Array<{ step: number; value: number }>, stalled: boolean): string {
  const curve = scores.map((s) => `${s.step}:${(s.value * 100).toFixed(0)}%`).join(' → ')
  return stalled
    ? `⚠️ 进度停滞（连续检查点 Δ<3%）：${curve} —— 当前策略疑似失效，建议换路而非继续堆叠同质步骤`
    : `进度曲线：${curve}`
}
