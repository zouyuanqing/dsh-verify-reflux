# dsh-verify-reflux 设计定稿

三平面验证器：执行平面（隐藏补全评分 + 种子化锦标赛）/ 呈现平面（轨迹落盘）/
上下文平面（L1/L2 分层回流）。v1 纯 Host 侧，无浏览器半侧。

## 探针结论（2026-07-14）

1. **模型复用**：`ctx.llm.stream({provider, model, messages, temperature, ...})`
   是公开 API，走注册 adapter，按操作经 `ctx.credentials` 解析会话凭证。
   → 零额外配置，直接用当前会话模型做评分补全。
2. **logprobs 不可行**：harness 流协议 chunk 类型为
   `block-start/text-delta/reasoning-delta/tool-call-delta/block-end/usage/finish`，
   无 logprob 载荷。→ 主档 = 隐藏补全让模型自报「众数字母 + 置信档」，
   编排器映射为模板分布后求数学期望；可选直连 HTTP 的 logprob 档留作 v2。
3. **加载**：cordis.patch.yml `- insert: {id, name}`，name 为模块说明符；
   构建产物 lib/ 可被 profile 解析。

## 概率化评分（模板分布）

20 级字母刻度 A..T，value(i) = i/19 ∈ [0,1]。

| 置信档 | 分布 |
|---|---|
| high | mode .70，±1 各 .15 |
| medium | mode .60，±1 各 .15，±2 各 .05 |
| low | mode .40，±1 各 .20，±2 各 .10 |

期望 score = Σ p(letter)·value(letter)；k 次扰动重评取均值，
标准差即回注块里的 margin/不确定性。

**扰动源**（in-band 无独立采样，靠提示制造条件独立性）：
候选呈现顺序轮转、评审视角轮换（正确性工程师→安全审计员→性能工程师）、
每次重评禁止引用前轮结论。

## 工具组

### verify_select(problem, candidates[], criteria{}, opts)
1. 种子化 rng（mulberry32）洗牌 → **环赛 + 枢纽锦标赛**：
   - 环赛：洗牌序上相邻两两各比一次（N 场），保证图连通——
     否则所有非枢纽只遇到同一组枢纽时无法互相区分（实测四路并列）；
   - 枢纽轮：k 个枢纽（默认 2），其余候选各与枢纽比一次（(N−k)·k 场），
     单次补全同时给双方字母+置信，省一半调用。
   - 合计 N + k(N−k) ≈ O(Nk) 场。
2. 聚合：**Bradley-Terry 强度拟合**（Zermelo 迭代）而非均值——
   均值不感知对手强度，全胜同度数会精确并列；BT 沿
   "A 胜 B、B 胜 C"的链路传播优势。强度归一化后 squash 到 [0,1]。
3. 蒸馏补全：对胜者产 L2 决胜链（≤200 token，强制三段式）。
4. 回注：
   - L1 行：`Best: candidate B (0.72 vs 0.58; margin 0.04; seed 42)`
   - L2 块：`<verified_decision model=… seed=… margin=… traces=…>`
     内含 ①决胜约束 ②否决记录 ③险胜边际
5. 全轨迹（每次补全的原始输出、分布、对阵）写 `.verifier/traces/<ts>-select.md`。
6. 否决墓碑追加 `.verifier/graveyard.md`（封顶最近 10 条）。

### verify_check(problem, candidate, criteria{})
单候选风险地图：处决测试（3 种最可能死法逐一排查）→ 各标准分布评分。
N=1 时 L2 蒸馏退化为风险地图回注。同样落盘轨迹、可写墓碑。

### verify_track(problem, steps[], checkpoints?)
逐检查点增量比较（当前 vs 上一检查点，把绝对打分变相对判断）。
产出进度曲线；连续两点 Δ<0.03 判停滞，L1 行加 ⚠️ 标记建议换路。

## 回流红线

呈现层可仿思维链样式，上下文不可伪出处：L2 一律带 provenance 的
`<verified_decision>` 结构化块，绝不伪装成主模型 reasoning。

## 模型解析顺序

config.provider/model → ctx.llm.listProviders() 首个活跃路由 +
listModels() 默认模型。温度默认 0（种子化可复现），maxTokens 512。

## v1 明确不做

- 浏览器半侧 / deepthink 面板（需复刻 clientBundle 构建，v2）
- logprob 直连档（配置 baseUrl 后启用，v2）
- 墓碑语义合并（只做截断与追加）

## 测试实证边界（25 用例）

- n=6, k=2，距离缩放边际，8 个种子：Kendall ≤ 1，真最优恒进前二；
- n=8, k=4 同条件：Kendall ≤ 2，真最优恒进前二；
- 均匀边际的退化 stub 下不承诺唯一冠军（信息论上限：所有胜利携带
  相同证据量时，未直接相遇的 undefeated 候选不可区分），只断言
  不败者进前二且分数唯一最大值存在。

## v2 已落地：直连档（真 logprob 分布）

探针实证（2026-08-25）：OpenRouter 通道会剥离 logprobs（多模型请求均无
返回字段）→ 会话路由下论文原机制物理不可行；DeepSeek 官方 API 实测返回
完整 token 级 logprobs ✓。

实现：`src/direct.ts` —— 要求模型输出 `SCORE:<letter>`，解析内容 token
流中首个裸字母决策点，聚合该位置 top_logprobs 中所有单字母质量并归一化，
对 20 级刻度取期望。配置三选一启用：

    - insert:
        - id: verify-reflux
          name: dsh-verify-reflux
          config:
            verifierBaseUrl: https://api.deepseek.com   # 任一支持 logprobs 的端点
            # verifierApiKeyEnv: DEEPSEEK_API_KEY       # 默认即此，经 ctx.credentials 解析
            # verifierModel: deepseek-chat

未配置时自动回退会话模型模板档——两档并存，凭证永远只引用环境变量名。

### 直连档首测（deepseek-chat, temperature=0）

| 候选 | 判定 | 分布 | 期望 |
|---|---|---|---|
| `return a-b`（坏） | A | A:100% | 0.000 |
| 带类型守卫的正确版 | T | T:100% | 1.000 |

简单案例分布饱和为一热；粒度优势预期在模糊案例上体现（待评测脚手架验证）。

## v2.1 已落地：判分器阶梯（兼容所有会话模型）

同一绝对评分接口，按保真度自动降级，运行中失手自动落档并在轨迹记
`[degrade]`、回流带 `via=` 出处徽标：

| 档 | 机制 | 覆盖 |
|---|---|---|
| T1 logprob | 直连端点真 token 分布 | 配置 verifierBaseUrl 且探测通过 |
| T2 sample | 同题采样 6 次，频次+拉普拉斯平滑 → 分布 | **所有 ctx.llm 路由** |
| T3 template | 单次补全众数+置信模板 | 同上（兜底） |

能力探测一次一缓存（.verifier 能力表语义在内存），失败端点冷却 1 小时
不重试。T2 的频次收敛于真实输出分布——数学上比固定模板更接近论文，
且把"重复评估"scaling 轴从方差缩减升级为分布估计。

## v2.2 客户端半侧：Think 式验证卡片（Phase A ✅）

`lib/client.js` 以官方 ModuleLoader 包装注册 `tool.call.toolview` 键控槽位的
三个 occupant（verify_select/check/track），接管默认通用卡片：

- 折叠态一行摘要（Best 结论 / margin chip / via 徽标）
- 展开态：决胜链 ①②③ + provenance 徽标行 + 可再展开的原始输出
- 注册是 additive 的（未认领 key 回落通用卡），零风险接管自家工具

加载管线：host 启动时读组合树的 `dsh.client` 声明 → boot manifest →
`/plugins/dsh-verify-reflux/client.js`。改动需重启主机+刷新页面。

### Phase B/C 路线（已立项）
- B 直播面板：judge 补全 text-delta → 会话事件流 → 面板订阅渲染 DeepThink 过程
  （待勘察：dsh-client-connection 的 connection-stream 投递面）
- C 可对话线程：面板输入框 → host verifier-thread Service → 独立 LLM 循环，
  历史落 `.verifier/threads/`；经 api-gateway Remote 暴露 host.call 端点

## v2.3 预轮 DeepThink：system-prompt/assemble 瀑布（Phase B'）

`preTurnDeepThink: off|light|full` 挂进官方组装瀑布——瀑布 resolve 前主模型
不会发出请求，即「上下文注入完成才继续输出」的原生语义：

- light：零延迟，注入既有裁决快照 + 墓碑尾 3 条（勿重试清单）
- full：一次有界补全产出 ≤3 条风险 bullet；失手静默降级 light
- 注入形态：user-role 快照 `<pre_turn_deepthink>…</pre_turn_deepthink>`

与 verified-state 记忆互补：记忆是「过去裁决的持久在册」，预轮是「本轮
生成前的风险前置」。真·模型内部思考通道（reasoning-delta 装饰）因 llm
服务无公开中间件缝而搁置 —— 影子替换核心服务风险不可接受。

### v2.3.1 会话隔离（审计修正）
验证状态改 WeakMap<Agent, ring>——以 harness 自身的 scope 路由键（Agent
对象）分桶：陌生会话状态恒空、瀑布不注入；仅跑过 verify_* 的会话进入
预轮 DeepThink 名单。`preTurnEverywhere` 显式打开全域（默认 false）。

### v2.4 设置卡片 + 动态档位
宿主注册 settings 命名空间 `verify-reflux`（preTurnDeepThink/preTurnEverywhere），
浏览器半区在 `settings.plugin.item` 键控槽位渲染配置卡：三档单选 + 全域开关，
直走绑定作用域 revision-fenced set() 即时持久化。瀑布监听器每次组装动态读
settings（patch Config 仅兜底）——改档位无需重启。

### v2.4.1 评分路由修复（真实环境首战 bug）
工具执行时 exec.agent.options 才是会话真正在用的路由；resolveRoute 的
first-registered 回退可能指向未配置凭证的适配器（如 deepseek-official
无 key），导致 SCORE 采样与 JSON 模板双档全部拿不到有效输出。现在三个
工具的评分路由优先取 sessionRoute(exec)，config 仅作无代理场景兜底；
check 兜底失败时报错携带所用路由，便于一眼定位。
