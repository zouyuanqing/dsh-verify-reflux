# Changelog

## 0.1.0 — 2026-08-25

首次发布。

- 三工具组：`verify_select` / `verify_check` / `verify_track`
- 判分器阶梯自动降级：T1 logprob 直连 → T2 会话采样分布 → T3 众数置信模板
- 种子化链式+枢纽锦标赛，Bradley-Terry 强度聚合
- L1/L2 分层回流（`<verified_decision>` 带 provenance），L3 轨迹落盘 `.verifier/traces/`
- 否决墓碑表 `.verifier/graveyard.md`（封顶 10 条）
- `verify_track` 停滞检测（连续 Δ<3% 告警换路）
