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
    maxTokens: options.maxTokens ?? 512,
    signal: options.signal,
  })
  let text = ''
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  return text
}

/** Resolve the default route lazily: config override, else first registered. */
export async function resolveRoute(
  llm: {
    listProviders(): unknown
    listModels(provider: string): unknown
  },
  config: { provider?: string; model?: string },
): Promise<{ provider: string; model: string }> {
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
  return { provider, model }
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
