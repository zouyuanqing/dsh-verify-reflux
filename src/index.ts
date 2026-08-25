/**
 * dsh-verify-reflux: 三平面验证器插件入口。
 *
 * inject ['tools','systemPrompt','llm']：评分补全走 ctx.llm.stream，
 * 会话凭证由 adapter 按操作解析——零额外配置，当前对话模型即验证模型。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { comparePair } from './scorer.js'
import type { Criteria } from './scorer.js'
import { runTournament } from './tournament.js'
import { distillVerdict, isValidRecord } from './distill.js'
import { formatCheckReflux, formatSelectReflux, formatTrackLine } from './reflux.js'
import { createVerifiedStateRegistry, keyOf } from './state.js'
import type { StateKey, VerdictEntry } from './state.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RefluxMeta } from './reflux.js'
import { createTraceSink } from './trace.js'
import { resolveRoute } from './llm.js'
import { completeText } from './llm.js'
import { judgeScore, mean, stdev } from './scale.js'
import { scoreDirect, expectationOf } from './direct.js'
import type { DirectEndpoint } from './direct.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { bradleyTerry, preference } from './tournament.js'
import { makeSamplingJudge, createCapabilityStore, probeLogprobs, absolutePrompt, extractScoreLetter } from './judges.js'
import type { DistributionJudge } from './judges.js'

export const name = 'verify-reflux'

export const inject = ['tools', 'systemPrompt', 'llm'] as const

export interface Config {
  provider?: string
  model?: string
  select?: boolean
  check?: boolean
  track?: boolean
  /** 直连档：配置后评分走该端点的真 token 分布（论文原机制），否则用会话模型模板档。 */
  verifierBaseUrl?: string
  verifierApiKeyEnv?: string
  verifierModel?: string
  /**
   * 预轮验证器前置思考：挂进 system-prompt/assemble 瀑布，主模型等注入完成后才生成。
   * off=关闭；light=零延迟（仅既有裁决+墓碑）；full=一次有界补全产出风险清单，失败静默降级。
   */
  preTurnDeepThink?: string
  /** 谨慎：true 时预轮注入作用于全部会话（默认仅限跑过验证的会话）。 */
  preTurnEverywhere?: boolean
}

export const Config: z<Config> = z.object({
  provider: z.string(),
  model: z.string(),
  select: z.boolean().default(true),
  check: z.boolean().default(true),
  track: z.boolean().default(true),
  verifierBaseUrl: z.string(),
  verifierApiKeyEnv: z.string(),
  verifierModel: z.string(),
  preTurnDeepThink: z.string().default('off'),
  preTurnEverywhere: z.boolean().default(false),
})

interface Route {
  provider: string
  model: string
}

function criteriaSchema() {
  return {
    type: 'object' as const,
    additionalProperties: true as const,
    required: true as const,
    description:
      'Evaluation criteria as {name: description}, e.g. {"Correctness": "Does it actually work?"}.',
  }
}

export function apply(ctx: Context, config: Config): void {
  const flags = {
    select: config.select ?? true,
    check: config.check ?? true,
    track: config.track ?? true,
  }
  const sink = createTraceSink(process.cwd())

  /**
   * 判分器阶梯解析：T1 logprob 直连（配置+探测通过）→ T2 会话模型采样分布
   * → 返回 null 走模板档。能力探测结果带冷却期缓存，失败端点一小时内不重试。
   */
  // credentials 为可选缝：缺席时仅禁用直连档，插件照常加载。
  const credService: { resolve(ref: unknown): Promise<{ value: string } | undefined> } | undefined = (() => {
    try { return (ctx as { credentials?: typeof credService }).credentials } catch { return undefined }
  })()
  const caps = createCapabilityStore()
  const ABS_SYSTEM =
    'You are a skeptical independent reviewer. Grade the solution on a 20-letter scale: ' +
    'A = total failure (0%), T = flawless (100%). Silently run an execution test first: ' +
    'find the most likely production failure and check whether the code guards against it. ' +
    'Reply ONLY in the form SCORE:X where X is one letter A-T.'
  const buildDirectJudge = async (): Promise<DistributionJudge | null> => {
    if (!config.verifierBaseUrl) return null
    const apiKeyEnv = config.verifierApiKeyEnv || 'DEEPSEEK_API_KEY'
    const model = config.verifierModel || 'deepseek-chat'
    const host = new URL(config.verifierBaseUrl).host
    const capKey = `logprob@${host}/${model}`
    let ok = caps.get(capKey)
    if (ok === undefined) {
      if (!credService) { caps.set(capKey, false); return null }
      const hit = await credService.resolve(credentialRef(apiKeyEnv))
      ok = hit
        ? await probeLogprobs(
            { baseUrl: config.verifierBaseUrl!, apiKey: hit.value, model },
            (u, init) => fetch(u, init),
          )
        : false
      caps.set(capKey, ok)
    }
    if (!ok) return null
    const ref = credentialRef(apiKeyEnv)
    return {
      tier: 'logprob',
      via: capKey,
      async dist({ problem, candidate, criterion, signal }) {
        if (!credService) throw new Error(`credentials service unavailable — T1 disabled`)
        const hit = await credService.resolve(ref)
        if (!hit) throw new Error(`verifier credential ${apiKeyEnv} is not configured`)
        const r = await scoreDirect(
          { baseUrl: config.verifierBaseUrl!, apiKey: hit.value, model },
          { system: ABS_SYSTEM, prompt: absolutePrompt(problem, criterion, candidate), signal },
          (u, init) => fetch(u, init),
        )
        return { dist: r.dist, raw: `letter=${r.letter} dist=${JSON.stringify(r.dist)}` }
      },
    }
  }
  const resolveJudge = async (route: { provider: string; model: string }): Promise<DistributionJudge> => {
    const direct = await buildDirectJudge()
    if (direct) return direct
    return makeSamplingJudge(ctx.llm, route, { system: ABS_SYSTEM, samples: 6 })
  }
  /** 绝对评分全流程；任何一层失手自动降级模板并返回 null。 */
  const absScoresVia = async (
    judge: DistributionJudge,
    args: { problem: string; candidates: readonly string[]; names: string[]; criteria: Criteria },
    rawLog: string[],
    signal?: AbortSignal,
  ): Promise<{ scores: number[]; perCriterion: number[][] } | null> => {
    try {
      const perCriterion: number[][] = []
      for (let i = 0; i < args.candidates.length; i++) {
        signal?.throwIfAborted()
        const per: number[] = []
        for (const name of args.names) {
          const { dist, raw } = await judge.dist({
            problem: args.problem,
            candidate: args.candidates[i]!,
            criterion: `${name}: ${args.criteria[name] ?? ''}`,
            signal,
          })
          per.push(expectationOf(dist))
          rawLog.push(`cand ${i} / ${name}: ${expectationOf(dist).toFixed(3)} [${judge.tier}] ${raw.slice(0, 120)}`)
        }
        perCriterion.push(per)
      }
      return { scores: perCriterion.map((per) => mean(per)), perCriterion }
    } catch (err) {
      rawLog.push(`[degrade] tier ${judge.tier} failed → template fallback: ${String(err).slice(0, 160)}`)
      return null
    }
  }

  // 验证记忆：每次 verify_* 后，模型在后续每一轮都读到这份持久快照。
  // 设置命名空间（软依赖）：服务缺席时配置卡不可用，但插件照常加载，
  // 档位回落 patch Config。绝不因可选缝失败而拒绝启动。
  const verifySettings: { get(): { preTurnDeepThink?: string; preTurnEverywhere?: boolean } } | undefined =
    (() => {
      try {
        const svc = (ctx as { settings?: { register(ns: unknown, schema: unknown): { get(): unknown } } }).settings
        if (!svc?.register) return undefined
        return svc.register(
          settingsNamespace('verify-reflux'),
          z.object({
            preTurnDeepThink: z.string().default('off'),
            preTurnEverywhere: z.boolean().default(false),
          }),
        ) as { get(): { preTurnDeepThink?: string; preTurnEverywhere?: boolean } }
      } catch {
        return undefined
      }
    })()
  const verifiedState = createVerifiedStateRegistry()
  // 评分路由跟随执行代理自己的 provider/model —— 那是当前会话正在用、
  // 且被证明可用的路由；resolveRoute 的 first-registered 回退可能指向
  // 未配置凭证的默认适配器，导致全部判分补全失败。
  const sessionRoute = (exec: unknown): { provider?: string; model?: string } => {
    const a = (exec as { agent?: { options?: { provider?: string; model?: string } } }).agent
    if (!a?.options?.provider) return {}
    return { provider: a.options.provider, model: a.options.model ?? '' }
  }
  const execKey = (exec: { agent?: unknown }): StateKey => keyOf(exec.agent)
  const recordVerdict = (exec: { agent?: unknown }, entry: Omit<VerdictEntry, 'time'>): void => {
    verifiedState.record(execKey(exec), { ...entry, time: new Date().toISOString().slice(11, 19) })
  }
  ctx.systemPrompt.context({
    name: 'verify-reflux:state',
    order: 150,
    text: (ac) => verifiedState.renderFor(keyOf(ac?.scope)),
  })

  // ── 预轮 DeepThink：挂进官方 system-prompt/assemble 瀑布 ──────────────────
  // 瀑布必须 resolve 主模型的请求才会发出 —— 「主会话模型等到上下文注入后
  // 才继续输出」正是这里的字面语义。full 档失手静默降级 light，绝不阻塞。
  const normalizeTier = (v: unknown): 'off' | 'light' | 'full' =>
    v === 'light' || v === 'full' ? v : 'off'
  const effectiveTier = (): 'off' | 'light' | 'full' => {
    if (!verifySettings) return normalizeTier(config.preTurnDeepThink)
    try {
      return normalizeTier(verifySettings.get().preTurnDeepThink)
    } catch {
      return normalizeTier(config.preTurnDeepThink)
    }
  }
  const effectiveEverywhere = (): boolean => {
    if (!verifySettings) return !!config.preTurnEverywhere
    try {
      return !!verifySettings.get().preTurnEverywhere
    } catch {
      return !!config.preTurnEverywhere
    }
  }
  const graveyardTail = (): string => {
    try {
      const raw = readFileSync(join(process.cwd(), '.verifier', 'graveyard.md'), 'utf8')
      return raw
        .split('\n')
        .filter((l) => l.trim().startsWith('-'))
        .slice(-3)
        .join('\n')
    } catch {
      return ''
    }
  }
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = await next()
    const preTurn = effectiveTier()
    if (preTurn === 'off') return out
    const sKey = keyOf(context?.scope)
    if (!verifiedState.hasEngaged(sKey) && !effectiveEverywhere()) return out
    const settled = verifiedState.renderFor(sKey)
    const grave = graveyardTail()
    let text = ''
    if (preTurn === 'full') {
      try {
        const route = await resolveRoute(ctx.llm, config)
        const reply = await completeText(ctx.llm, {
          ...route,
          system:
            'You are the pre-flight verifier. Given settled verdicts and rejected approaches, ' +
            'output AT MOST 3 terse risk bullets the next change must respect. No preamble.',
          prompt: [settled || '(no verdicts yet)', grave ? 'Rejected:\n' + grave : '']
            .filter(Boolean)
            .join('\n\n'),
          signal: context?.signal,
        })
        text = reply.trim()
      } catch {
        // full 失手 → 落到 light 的静态拼装
      }
    }
    if (!text) {
      const parts: string[] = []
      if (settled) parts.push('Settled verification state (respect it):\n' + settled)
      if (grave) parts.push('Rejected approaches (do not retry):\n' + grave)
      if (parts.length) text = parts.join('\n\n')
    }
    if (text) {
      out.contexts.push({
        name: 'verify-reflux:preturn',
        text: '<pre_turn_deepthink>\n' + text + '\n</pre_turn_deepthink>',
      })
    }
    return out
  })


  ctx.systemPrompt.section({
    name: 'tool:verify-reflux',
    order: 120,
    text:
      'verify_* tools run probabilistic verification on the CURRENT session model via hidden ' +
      'completions: candidates are judged on a 20-letter scale with confidence bands, expanded ' +
      'into distributions and reduced to expected scores. Full evaluation traces never enter ' +
      'context — they are written under .verifier/traces/. Use verify_select for best-of-N ' +
      '(seeded pivot tournament + distilled decision record), verify_check before committing a ' +
      'single solution (execution-test risk map), verify_track during long tasks (progress ' +
      'curve with stall detection). Consult .verifier/graveyard.md before re-proposing an ' +
      'approach — rejected ones are recorded there.',
  })

  // 自诊断：一次调用回报 评分路由 / 模型原始回复 / 解析结果。verify_* 失败时先跑它。
  ctx.tools.register(
    defineTool({
      name: 'verify_selftest',
      description:
        'One-round diagnostic for the verification pipeline. Resolves the scoring route, sends a minimal ' +
        'hidden completion, and reports the raw reply plus parse result. Run this when verify_* tools fail.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { reflux: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text' as const, text: String(value.reflux) }],
      },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(_args, exec) {
        exec.signal?.throwIfAborted()
        const route = await resolveRoute(ctx.llm, { ...config, ...sessionRoute(exec) })
        const lines: string[] = [
          `route: ${route.provider}/${route.model}`,
          `budget: ${route.maxTokens ? route.maxTokens + ' tokens (model catalog)' : '4096 (default)'}`,
        ]
        let letter: string | null = null
        try {
          const reply = await completeText(ctx.llm, {
            ...route,
            system: 'Output ONLY minified JSON.',
            prompt: 'Reply exactly: SCORE:C',
            signal: exec.signal,
          })
          lines.push(`reply(${reply.length} chars): ${reply.slice(0, 300) || '(empty)'}`)
          letter = extractScoreLetter(reply)
          lines.push(`parsed letter: ${letter ?? 'NONE'}`)
        } catch (err) {
          lines.push(`completion FAILED: ${String(err).slice(0, 240)}`)
        }
        const verdict = letter ? 'PASS' : 'FAIL'
        const reflux =
          `selftest ${verdict} — scoring route ${route.provider}/${route.model}\n` +
          '<verified_decision tool="verify_selftest" model="' + route.provider + '/' + route.model + '" via="diagnostic">\n' +
          lines.map((l) => '• ' + l).join('\n') +
          '\n</verified_decision>'
        if (!letter) throw new Error(reflux)
        return { reflux }
      },
    }),
  )

  if (flags.select) {
    ctx.tools.register(
      defineTool({
        name: 'verify_select',
        description:
          'Best-of-N selection on the current session model: seeded pivot tournament of hidden ' +
          'probabilistic comparisons (O(N·k)), then a distilled three-part decision record ' +
          '(decisive constraints / rejection causes / near-ties). Returns L1 verdict line + L2 ' +
          '<verified_decision> block; full traces stay out of context.',
        parameters: {
          problem: { type: 'string', required: true, description: 'The task every candidate attempts.' },
          candidates: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Candidate solutions/plans to rank.',
          },
          criteria: criteriaSchema(),
          pivots: { type: 'integer', description: 'Pivot count k. Defaults to 2.' },
          seed: { type: 'integer', description: 'Tournament seed. Defaults to 42.' },
          repeats: {
            type: 'integer',
            description: 'Independent scoring repeats per comparison (stance + order rotated). Defaults to 2.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              reflux: { type: 'string', required: true },
              winnerIndex: { type: 'integer', required: true },
              scores: { type: 'json', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text' as const, text: String(value.reflux) }],
        },
        timeoutMs: 600_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          exec.signal?.throwIfAborted()
          const route: Route = await resolveRoute(ctx.llm, { ...config, ...sessionRoute(exec) })
          const n = args.candidates.length
          if (n === 0) throw new Error('candidates must be non-empty')
          const criteria = args.criteria as Criteria
          const seed = typeof args.seed === 'number' ? args.seed : 42
          const pivots = typeof args.pivots === 'number' ? args.pivots : 2
          const repeats = typeof args.repeats === 'number' ? args.repeats : 2

          const rawLog: string[] = [`# verify_select ${new Date().toISOString()} seed=${seed} n=${n}`]
          const judge = await resolveJudge(route)
          let via: string | undefined = judge.via
          let tournament
          const scored = judge
            ? await absScoresVia(
                judge,
                { problem: args.problem, candidates: args.candidates, names: Object.keys(criteria), criteria },
                rawLog,
                exec.signal,
              )
            : null
          if (scored) {
            // 绝对分（logprob 或采样分布）→ 全 round-robin 偏好矩阵 → Bradley-Terry。
            const wins = scored.scores.map((s, i) =>
              scored.scores
                .map((tt, j) => ({ opponent: j, pref: preference(s, tt) }))
                .filter((w) => w.opponent !== i),
            )
            const scores = bradleyTerry(wins)
            const ranking = [...Array(n).keys()].sort((x, y) => scores[y]! - scores[x]! || x - y)
            tournament = { ranking, scores, winner: ranking[0]!, runnerUp: ranking[1]!, nComparisons: 0 }
          } else {
            via = undefined // 判分器降级到模板档，回流不带 via 徽标
            tournament = await runTournament({
              candidates: args.candidates,
              pivots,
              seed,
              signal: exec.signal,
              compare: async (i, j) => {
                const r = await comparePair(
                  ctx.llm,
                  route,
                  args.problem,
                  args.candidates[i]!,
                  args.candidates[j]!,
                  criteria,
                  { repeats, signal: exec.signal },
                )
                rawLog.push(`\n## compare ${i} vs ${j}\n${r.raw.join('\n')}`)
                return r.scores
              },
            })
          }

          const best = tournament.winner
          const runnerUp = tournament.runnerUp
          let record = `① DECISIVE: candidate ${best} won on aggregate preference.\n② REJECTED: see trace.\n③ NEAR-TIE: unknown`
          if (n >= 2) {
            try {
              record = await distillVerdict(ctx.llm, {
                problem: args.problem,
                criteria,
                winnerIndex: best,
                winnerBody: args.candidates[best]!,
                losers: tournament.ranking
                  .filter((idx) => idx !== best)
                  .map((idx) => ({ index: idx, body: args.candidates[idx]!, score: tournament.scores[idx]! })),
                winnerScore: tournament.scores[best]!,
                runnerUpScore: tournament.scores[runnerUp]!,
                route,
                signal: exec.signal,
              })
              if (!isValidRecord(record)) record = fallbackRecord(best)
            } catch {
              record = fallbackRecord(best)
            }
          }

          const margin = Math.abs(tournament.scores[best]! - tournament.scores[runnerUp]!)
          recordVerdict(exec, {
            tool: 'verify_select',
            summary: `candidate ${best + 1} wins (runner-up ${tournament.runnerUp + 1}, margin ${margin.toFixed(3)})`,
            via,
          })
          const tracesPath = await sink.writeTrace(`${seed}-select.md`, [
            rawLog.join('\n'),
            `\n## ranking\n${tournament.ranking.map((i, r) => `${r + 1}. #${i} ${tournament.scores[i]?.toFixed(3)}`).join('\n')}`,
            `\n## decision record\n${record}`,
          ].join('\n'))
          await sink.appendGraveyard(
            `problem="${args.problem.slice(0, 60)}" → rejected #${runnerUp} (score ${tournament.scores[runnerUp]?.toFixed(3)})`,
          )
          const tail = await sink.graveyardTail(3)

          const meta: RefluxMeta = {
            tool: 'verify_select',
            provider: route.provider,
            model: route.model,
            via,
            seed,
            margin,
            tracesPath,
            graveyardPath: tail.length > 0 ? '.verifier/graveyard.md' : undefined,
          }
          const scoresLine = `score ${tournament.scores[best]?.toFixed(3)} vs ${tournament.scores[runnerUp]?.toFixed(3)}; ${tournament.nComparisons} comparisons`
          const reflux = formatSelectReflux({
            meta,
            bestLabel: `Best: candidate ${best}`,
            best: args.candidates[best]!,
            scoresLine,
            record,
          })
          return {
            reflux,
            winnerIndex: best,
            scores: Object.fromEntries(tournament.scores.map((s, i) => [String(i), s])) as JsonValue,
          }
        },
      }),
    )
  }

  if (flags.check) {
    ctx.tools.register(
      defineTool({
        name: 'verify_check',
        description:
          'Risk-map verification of ONE candidate on the current session model: execution-test ' +
          'review (most likely production failures checked against the solution) plus per-criterion ' +
          'probabilistic scoring. Returns risk-map reflux block; full trace stays out of context.',
        parameters: {
          problem: { type: 'string', required: true, description: 'The task this candidate solves.' },
          candidate: { type: 'string', required: true, description: 'The solution/plan to audit.' },
          criteria: criteriaSchema(),
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              reflux: { type: 'string', required: true },
              score: { type: 'number', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text' as const, text: String(value.reflux) }],
        },
        timeoutMs: 300_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          exec.signal?.throwIfAborted()
          const route = await resolveRoute(ctx.llm, { ...config, ...sessionRoute(exec) })
          const criteria = args.criteria as Criteria
          const names = Object.keys(criteria)
          const judge = await resolveJudge(route)
          const via = judge.via
          let score: number
          let spread: number
          const rawLog: string[] = [
            `# verify_check ${new Date().toISOString()}\nroute: ${route.provider}/${route.model} via=${via}`,
          ]
          try {
            const scored = await absScoresVia(
              judge,
              { problem: args.problem, candidates: [args.candidate], names, criteria },
              rawLog,
              exec.signal,
            )
            if (scored) {
              score = mean(scored.scores)
              spread = stdev(scored.perCriterion[0] ?? [])
            } else {
              const result = await comparePair(ctx.llm, route, args.problem, args.candidate, args.candidate, criteria, {
                repeats: 3,
                signal: exec.signal,
              })
              score = result.scores[0]!
              spread = result.spreads[0]!
              rawLog.push(...result.raw)
            }
          } catch (err) {
            // 失败也落盘：降级轨迹 + 终态错误，证据不再蒸发。
            rawLog.push(`## FATAL\n${String(err)}`)
            try {
              await sink.writeTrace(`failed-check-${Date.now()}.md`, rawLog.join('\n---\n'))
            } catch {}
            throw new Error(
              `${String(err).slice(0, 240)} — scoring route: ${route.provider}/${route.model}; ` +
                `forensics: .verifier/traces/`,
            )
          }
          const record =
            `① RISK: top failure modes found during execution test — see trace for per-criterion detail\n` +
            `② GUARDED: modes the candidate already defends against\n` +
            `③ SPREAD: repeat disagreement ±${spread.toFixed(3)}${spread > 0.15 ? ' (low verifier agreement — treat score cautiously)' : ''}`
          const tracesPath = await sink.writeTrace('check.md', rawLog.join('\n---\n'))
          recordVerdict(exec, {
            tool: 'verify_check',
            summary: `score ${(score * 100).toFixed(0)}% ±${(spread * 100).toFixed(0)} across ${names.length} criteria`,
            via,
          })
          const reflux = formatCheckReflux({
            meta: { tool: 'verify_check', provider: route.provider, model: route.model, via, tracesPath },
            scoresLine: `score ${score.toFixed(3)} across ${names.length} criterion/criteria`,
            record,
          })
          return { reflux, score }
        },
      }),
    )
  }

  if (flags.track) {
    ctx.tools.register(
      defineTool({
        name: 'verify_track',
        description:
          'Progress tracking on the current session model: each checkpoint is scored A(0%)..T(100%) ' +
          'against the task goal; consecutive deltas <3% flag strategy stall in the verdict line.',
        parameters: {
          problem: { type: 'string', required: true, description: 'The overall task.' },
          steps: {
            type: 'array',
            required: true,
            items: { type: 'string' },
            description: 'Steps taken so far, one string each (action + observed outcome).',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              reflux: { type: 'string', required: true },
              stalled: { type: 'boolean', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text' as const, text: String(value.reflux) }],
        },
        timeoutMs: 300_000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          exec.signal?.throwIfAborted()
          const route = await resolveRoute(ctx.llm, { ...config, ...sessionRoute(exec) })
          if (args.steps.length === 0) throw new Error('steps must be non-empty')
          const points: Array<{ step: number; value: number }> = []
          const raw: string[] = [`# verify_track ${new Date().toISOString()}`]
          for (let i = 0; i < args.steps.length; i++) {
            exec.signal?.throwIfAborted()
            const prefix = args.steps.slice(0, i + 1).map((s, k) => `${k + 1}. ${s}`).join('\n')
            const prompt = [
              `## Task\n${args.problem}`,
              `## Trajectory so far\n${prefix}`,
              'How much of the task is COMPLETE after these steps? Judge completion degree only, not quality.',
              'Respond ONLY with minified JSON: {"letter":"<A-T>","confidence":"high|medium|low"}',
            ].join('\n\n')
            const text = await completeText(ctx.llm, {
              ...route,
              system: 'Output ONLY minified JSON.',
              prompt,
              signal: exec.signal,
            })
            raw.push(`\n## checkpoint ${i + 1}\n${text}`)
            const judgment = parseSingleJudgment(text)
            points.push({ step: i + 1, value: judgeScore(judgment.letter, judgment.confidence) })
          }
          let stalled = false
          for (let i = 2; i < points.length; i++) {
            const d1 = points[i - 1]!.value - points[i - 2]!.value
            const d2 = points[i]!.value - points[i - 1]!.value
            if (d1 < 0.03 && d2 < 0.03 && points[i]!.value < 0.95) stalled = true
          }
          const tracesPath = await sink.writeTrace('track.md', raw.join('\n'))
          const last = points.at(-1)?.value ?? 0
          recordVerdict(exec, {
            tool: 'verify_track',
            summary: "progress " + Math.round(last * 100) + "% over " + points.length + " checkpoints" + (stalled ? ' · STALLED' : ''),
          })
          const reflux = [
            formatTrackLine(points, stalled),
            `<verified_decision tool="verify_track" model="${route.provider}/${route.model}" traces="${tracesPath}">`,
            `checkpoints scored: ${points.length}; final ${(points.at(-1)!.value * 100).toFixed(0)}%`,
            '</verified_decision>',
          ].join('\n')
          return { reflux, stalled }
        },
      }),
    )
  }
}

function fallbackRecord(winner: number): string {
  return (
    `① DECISIVE: candidate ${winner} led aggregate preference in the seeded tournament.\n` +
    `② REJECTED: details in trace file.\n` +
    `③ NEAR-TIE: see margins in trace.`
  )
}

function parseSingleJudgment(text: string): { letter: string; confidence: 'high' | 'medium' | 'low' } {
  const match = text.match(/\{[^{}]*"letter"\s*:\s*"([A-T])"[^{}]*"confidence"\s*:\s*"(high|medium|low)"[^{}]*\}/)
  if (!match) throw new Error(`cannot parse track judgment from: ${text.slice(0, 200)}`)
  return { letter: match[1]!, confidence: match[2]! as 'high' | 'medium' | 'low' }
}
