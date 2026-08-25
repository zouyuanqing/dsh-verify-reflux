import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'

/**
 * Minimal bridge onto the harness LLM runtime. Scoring calls are ordinary
 * hidden completions on the session's own provider route: credentials resolve
 * per operation inside the adapter, so nothing is configured or cached here.
 */

/** The slice of ctx.llm this plugin depends on (keeps tests honest). */
export interface LlmStreamService {
  stream(options: {
    provider: string
    model: string
    messages: ReturnType<typeof createUserMessage>[]
    system?: string
    temperature?: number
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<{ type: string; text?: string }>
}

export interface CompleteOptions {
  provider: string
  model: string
  system: string
  prompt: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/**
 * Run one hidden completion and collect its text deltas. Reasoning deltas are
 * deliberately dropped: scoring verdicts are read from the final text only,
 * keeping parsing deterministic regardless of how much the model thinks.
 */
export async function completeText(
  llm: LlmStreamService,
  options: CompleteOptions,
): Promise<string> {
  const chunks = llm.stream({
    provider: options.provider,
    model: options.model,
    messages: [
      createUserMessage({
        content: [{ type: 'text' as const, text: options.prompt }],
        source: { kind: 'plugin', plugin: 'dsh-verify-reflux' },
      }),
    ],
    system: options.system,
    temperature: options.temperature ?? 0,
    // 预算钳制：推理模型给大预算会「思考到上限」，判分延迟爆炸
    // （实测 hy3@64000 直接撞穿工具 5min 时限）。SCORE 判分思考 ~1-4k
    // 足够，8192 为安全天花板；目录值只影响下限参考。
    maxTokens: Math.min(options.maxTokens ?? 4096, 8192),
    signal: options.signal,
  })
  let text = ''
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  return text
}

export interface Route {
  provider: string
  model: string
  /** 模型目录声明的单次输出上限；判分预算按它取，推理模型的思考也计入 max_tokens。 */
  maxTokens?: number
}

/** Resolve the default route lazily: config override, else first registered.
 *  附带解析模型元数据里的输出上限（软依赖：服务不支持则无此字段）。 */
export async function resolveRoute(
  llm: {
    listProviders(): unknown
    listModels(provider: string): unknown
    resolveModel?(provider: string, model: string): Promise<unknown>
  },
  config: { provider?: string; model?: string },
): Promise<Route> {
  let provider = config.provider
  if (!provider) {
    const providers = (await llm.listProviders()) as Array<{ id: string }>
    provider = providers[0]?.id
    if (!provider) throw new Error('no registered LLM provider route found')
  }
  let model = config.model
  if (!model) {
    const models = (await llm.listModels(provider)) as Array<{ id: string }>
    model = models[0]?.id
    if (!model) throw new Error(`provider ${provider} advertises no models`)
  }
  let maxTokens: number | undefined
  try {
    const info = (await llm.resolveModel?.(provider, model)) as
      | { maxTokens?: unknown; max_tokens?: unknown; maxOutputTokens?: unknown }
      | undefined
    const cap = info?.maxTokens ?? info?.max_tokens ?? info?.maxOutputTokens
    if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) maxTokens = Math.floor(cap)
  } catch {
    // 元数据不可用 → 保持默认预算
  }
  return { provider, model, maxTokens }
}

/** Typed accessor so apply() can inject the real service. */
export function llmService(ctx: Context): LlmStreamService & {
  listProviders(): unknown
  listModels(provider: string): unknown
} {
  return ctx.llm as LlmStreamService & {
    listProviders(): unknown
    listModels(provider: string): unknown
  }
}
