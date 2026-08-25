# dsh-verify-reflux

[中文](README.md) | English

Three-plane probabilistic verifier for DeepSeek Harness (`dsh`): agents grade their own candidate solutions with **fine-grained probabilistic verification**, fully traced yet **context-clean** — verdicts reflux as layered blocks, full traces stay on disk.

Implements the core ideas of [LLM-as-a-Verifier](https://arxiv.org/abs/2607.05391) with context-economy extensions designed for harness life.

## Three planes

| Plane | Responsibility |
|---|---|
| Execution | Hidden-completion scoring over a 20-letter scale (A=0% … T=100%) with confidence → expectation; seeded chain+pivot tournament |
| Presentation | Every raw trace written to `<cwd>/.verifier/traces/`, never entering model context |
| Context | L1 verdict line + L2 three-part decision record inside a provenance-carrying `<verified_decision>` block |

## Judge ladder (automatic fallback)

One absolute-scoring interface, tiers picked by fidelity, degrading automatically with a `[degrade]` trace marker:

| Tier | Mechanism | Coverage | Fidelity |
|---|---|---|---|
| T1 logprob | True token distribution from a direct endpoint (the paper's original mechanism) | Endpoints returning logprobs (verified: DeepSeek official API ✓) | ★★★ |
| T2 sample | Sample the session model 6× per judgment; letter frequencies + Laplace smoothing → distribution | **Every ctx.llm route** | ★★ |
| T3 template | One completion self-reporting mode letter + confidence band | Same (fallback) | ★ |

Capability probes are cached once; failed direct endpoints cool down for 1 hour. Every verdict carries a `via="…"` provenance badge.

## Tools

| Tool | Capability |
|---|---|
| `verify_select` | Best-of-N: chain+pivot tournament O(Nk); winner distilled into a decision record (decisive constraints / rejection causes / near-ties) |
| `verify_check` | Risk map for one candidate: execution-test review + per-criterion probabilistic scoring |
| `verify_track` | Progress curve over checkpoints with stall detection (Δ < 3% twice in a row) |

Rejected approaches accumulate into `.verifier/graveyard.md` (last 10 kept) so long-running agents stop re-proposing dead paths.

## Install

Requires: dsh ≥ 0.1.1-rc, Node ≥ 18.

```sh
git clone https://github.com/zouyuanqing/dsh-verify-reflux.git
cd dsh-verify-reflux && npm install && npm run build

cp -r . ~/.dsh/profiles/web/node_modules/dsh-verify-reflux
```

Append to `~/.dsh/profiles/<name>/cordis.patch.yml`:

```yaml
- insert:
    - id: verify-reflux
      name: dsh-verify-reflux
```

Restart `dsh web`.

## Configuration

T2/T3 work out of the box on the current session model. To enable the paper-faithful T1:

```yaml
      config:
        verifierBaseUrl: https://api.deepseek.com
        verifierApiKeyEnv: DEEPSEEK_API_KEY   # default; resolved per-operation via ctx.credentials
        verifierModel: deepseek-chat
```

Credentials are referenced by environment-variable name only. Optional `provider`/`model` pins the session scoring route.

## Development

```sh
npm install --legacy-peer-deps
npm run check   # typecheck + build + node --test (33 tests)
```

See [DESIGN.md](DESIGN.md) for architecture details and empirically measured guarantees.

## License

[MIT](LICENSE)
