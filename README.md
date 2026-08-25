# dsh-verify-reflux

[English](README.en.md) | 中文

DeepSeek Harness（`dsh`）的三平面概率验证器插件：让智能体在会话内对自己的候选方案做**细粒度概率化验证**，验证过程全程留痕但**不污染上下文**——结论以分层回流块进入对话，完整轨迹落盘可审计。

基于 [LLM-as-a-Verifier](https://arxiv.org/abs/2607.05391) 框架思想实现，并针对 Harness 场景做了上下文经济学扩展。

## 三平面架构

| 平面 | 职责 |
|---|---|
| 执行 | 隐藏补全评分：20 级字母刻度（A=0% … T=100%）+ 置信分布 → 数学期望；种子化链式+枢纽锦标赛 |
| 呈现 | 全部原始轨迹写入 `<cwd>/.verifier/traces/`，绝不进入模型上下文 |
| 上下文 | L1 结论行 + L2 三段式决胜链（带 provenance 的 `<verified_decision>` 块） |

## 判分器阶梯（自动降级）

同一绝对评分接口，按保真度自动选择，失手自动落档并在轨迹记 `[degrade]`：

| 档 | 机制 | 覆盖 | 保真度 |
|---|---|---|---|
| T1 logprob | 直连端点读真 token 分布（论文原机制） | 配置了支持 logprobs 的端点（实测 DeepSeek 官方 API ✓） | ★★★ |
| T2 sample | 会话模型同题采样 6 次，频次+拉普拉斯平滑 → 分布 | **所有 ctx.llm 路由** | ★★ |
| T3 template | 单次补全自报众数+置信模板 | 同上（兜底） | ★ |

能力探测一次一缓存；失败的直连端点冷却 1 小时不重试。每个裁决的回流块都带 `via="…"` 出处徽标。

## 工具一览

| 工具 | 能力 |
|---|---|
| `verify_select` | best-of-N 选优：链式+枢纽锦标赛 O(Nk)，胜者产三段式决胜记录（①决胜约束 ②否决记录 ③险胜边际） |
| `verify_check` | 单方案风险地图：处决测试（最可能的失败模式逐一排查）+ 各标准概率评分 |
| `verify_track` | 进度追踪：检查点 A..T 打分成曲线，连续两点 Δ<3% 触发停滞告警 |

否决记录自动累积到 `.verifier/graveyard.md`（封顶最近 10 条），防止长任务里反复重提已被枪毙的方案。

## 安装

要求：dsh ≥ 0.1.1-rc、Node ≥ 18。

```sh
# 从源码构建
git clone https://github.com/zouyuanqing/dsh-verify-reflux.git
cd dsh-verify-reflux && npm install && npm run build

# 装入目标 profile 并接线
cp -r . ~/.dsh/profiles/web/node_modules/dsh-verify-reflux
```

在 `~/.dsh/profiles/<name>/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: verify-reflux
      name: dsh-verify-reflux
```

重启 `dsh web` 即生效。

## 配置判分档位

默认 T2/T3（零配置，用当前会话模型）。要启用论文原机制 T1：

```yaml
- insert:
    - id: verify-reflux
      name: dsh-verify-reflux
      config:
        verifierBaseUrl: https://api.deepseek.com   # 任一支持 logprobs 的 OpenAI 兼容端点
        verifierApiKeyEnv: DEEPSEEK_API_KEY         # 默认即此；经 ctx.credentials 按操作解析
        verifierModel: deepseek-chat
```

凭证永远只引用环境变量名，不落明文。可选：`provider`/`model` 指定会话评分路由（缺省取首个注册路由）。

## 使用示例

装好后直接在对话里说：

```text
我写了三个候选实现，用 verify_select 按「正确性、安全性」选出最好的，
然后对选中的实现 verify_check 看看风险地图。
```

回注形态（进入上下文的全部内容）：

```text
Best: candidate 1 | score 0.850 vs 0.150; 0 comparisons
<verified_decision tool="verify_select" model="test-route/mock-model" via="sample@test-route/mock-model" seed="42" margin="0.488" traces=".verifier/traces/1787628226022-42-select.md">
① DECISIVE: B guards both failure modes with input validation
② REJECTED: A subtracts instead of adding
③ NEAR-TIE: none
</verified_decision>
```

## 开发与测试

```sh
npm install --legacy-peer-deps
npm run check   # typecheck + build + node --test（33 用例）
```

设计细节与实证边界见 [DESIGN.md](DESIGN.md)。

## 许可证

[MIT](LICENSE)
