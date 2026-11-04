# opencode-free

Automatic model selection, health tracking, and failover for OpenCode's free
models. It discovers zero-cost models by catalog metadata rather than by name,
uses public-benchmark quality priors plus live reliability and speed, and routes
each role to the best currently healthy model.

The router never treats a paid model as a fallback. If every free candidate is
unavailable, it stops with a clear cooldown instead of quietly spending money.

## Requirements

- OpenCode **2.x** with the V2 plugin API. Tested with OpenCode `2.2.5`.
- Node.js 22 or newer for the CLI.
- No paid API subscription is required. Free-model availability, region,
  retention policy, and account-wide limits are still controlled by OpenCode.

## Install

From this repository, without a global npm install:

```bash
npm install
npm link
opencode-free install
ocf
```

`npm link` creates global `opencode-free` and `ocf` commands pointing back to
this checkout, so changes are picked up automatically. If you prefer not to
link the package, run the same commands through
`node bin/opencode-free.js install` and `node bin/opencode-free.js opencode`.

Restart OpenCode after `install`. The command creates one symlink at
`~/.config/opencode/plugins/opencode-free.js` (or the directory selected by
`OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME`). It refuses to overwrite anything it
does not own. This is the only installation needed for the plugin.

Alternatively, add aliases to your shell profile:

```bash
alias opencode-free='node /Users/macair/projects/opencode-free/bin/opencode-free.js'
alias ocf='node /Users/macair/projects/opencode-free/bin/ocf.js'
```

Once the package is published to npm or installable from Git, the canonical
OpenCode installation will be:

```bash
opencode plugin add opencode-free
```

That lets OpenCode manage the package itself. It is not available yet because
the package is not published.

`init` discovers the current free catalog and writes settings and state under:

```text
~/.local/state/opencode-free/
```

Use `OPENCODE_FREE_HOME` to keep a separate state directory.

## Quick start

```bash
opencode-free install
opencode-free init
ocf
```

`ocf` starts OpenCode with the current plan, build, and fast routes already
assigned to the built-in agents. `opencode-free opencode` is the explicit
equivalent; every argument is passed through to OpenCode:

```bash
ocf
ocf run "Fix the failing tests"
opencode-free opencode --continue
```

For `ocf`, management commands such as `status`, `scan`, and `probe` keep
their normal meaning; any other arguments launch OpenCode. For example,
`ocf status` shows router status, while `ocf run ...` starts OpenCode.

If no catalog has ever been initialized or scanned, the launcher runs the
equivalent of `init` automatically. With `probe.onAssign` enabled by default, it
also probes stale assignment candidates before routing. Set that option to
`false` for strictly network-free assignment.

The launcher writes model assignments only into the child OpenCode process,
through `OPENCODE_CONFIG_CONTENT`. It does not permanently edit global or
project configuration, and it preserves unrelated inline agent settings. The
plugin remains responsible for live routing and failover, so a long-running
session can move to another healthy free model as conditions change.

Automatic routing applies until you manually change the model in a session.
That manual choice then sticks for the rest of the session, whether it is free
or paid; start a new session to resume automatic routing. If no eligible free
model exists, the launcher stops with a clear error instead of starting with a
paid fallback.

`init` itself makes **no model requests**. On launch, stale assignment candidates
are probed automatically before routes are chosen. This means a normal
`ocf` start can discover that the public-prior winner is currently inaccessible
or heavily queued without requiring a separate command.

`init` and `scan` list each model's public prior scores for plan/build/verify/fast
(`public P/B/V/F`). `— (neutral)` means the model ID has no exact public or
configured mapping. Unmapped models receive the median mapped prior for the
requested role and remain eligible for routing. A small exploration quota gives
them an occasional normal session so they are not permanently shut out.

Availability probing is deliberately bounded:

- It selects the top plan and build candidates plus an unknown-model candidate,
  not only the current winner.
- It sends one no-tool, single-turn request asking for exactly `ok`.
- It records availability, response status, and latency only. It does not measure
  planning or coding quality and does not change the quality score.
- Fresh failures temporarily remove a model from assignment. Probe latency acts
  as a low-confidence speed signal.
- If every candidate is unavailable, the launch falls back to public-prior
  routing instead of refusing to start.

```bash
opencode-free probe              # probe stale assignment candidates
opencode-free probe --all        # inventory every free model
opencode-free probe --model opencode/beam-free --refresh
```

`benchmark` and `bench` remain aliases for `probe`. `--full` is rejected with a
clear error because full local quality benchmarking was removed. Successful
probes are cached for one hour by default; ordinary failures expire after ten
minutes and access failures after six hours. Catalog changes preserve existing
per-model probe results and probe only new or stale models.

If a provider-wide rate limit or quota error occurs, the probe stops scheduling
models for that provider, records the cooldown for normal routing, and reports
remaining models as skipped rather than burning the rest of the quota through
model-by-model retries.

## Commands

| Command | Purpose |
|---|---|
| `opencode-free opencode [args...]` | Start OpenCode with routed agent models; `ocf [args...]` does the same unless the first argument is a management command |
| `opencode-free install` | Install the plugin symlink; safe to rerun |
| `opencode-free uninstall` | Remove only the symlink owned by this package |
| `opencode-free init` | Discover models and initialize settings |
| `opencode-free scan` | Refresh the free-model catalog |
| `opencode-free probe` | Check availability with one request per selected model |
| `opencode-free status` | Show recommendations, pins, health, cooldowns, and last route |
| `opencode-free scores [--role plan]` | Show cached routing inputs, ranks, and fallback chains |
| `opencode-free why` | Print the last routing decision with scores |
| `opencode-free priors` | Show public quality priors and configured overrides |
| `opencode-free pin plan opencode/model#variant` | Pin one role |
| `opencode-free unpin build` | Remove a role pin |
| `opencode-free profile quality\|balanced\|fast` | Change routing weights |
| `opencode-free auto` / `off` | Enable or disable routing |
| `opencode-free ignore provider/model` | Exclude a model |
| `opencode-free ignore-provider provider` | Exclude every model from a provider |
| `opencode-free allow-provider provider` | Remove a provider exclusion |
| `opencode-free config` | Show paths and effective settings |

Most commands accept `--json` for scripting.

## How routing works

Each request is grouped into one of four roles:

| Role | Used by |
|---|---|
| `plan` | OpenCode Plan, Relay planner |
| `build` | OpenCode Build, Relay implementer |
| `verify` | Relay verifier and watcher, review agents |
| `fast` | Relay orchestrator and lightweight exploration |

The router:

1. Hard-gates candidates: enabled, chat, tool-capable, zero cost, allowed
   provider, not excluded, healthy, and compatible with image attachments.
2. Before assignment, probes stale candidates from the top plan/build pool and
   temporarily excludes fresh availability failures.
3. Selects a role-appropriate model variant (for example `high` reasoning for
   quality planning, `medium` or `low` for faster building).
4. Scores candidates using public quality priors, observed reliability, recent
   latency/throughput, fresh probe latency, and profile weights. Unmapped models
   use the median mapped prior for the role. A separate per-session exploration
   quota occasionally assigns a healthy unmapped model instead of relying on an
   additive bonus.
5. Uses soft provider diversity in `balanced` and `fast` profiles when more
   than one provider has eligible models. Planning keeps its strongest
   candidate; later roles avoid reusing that provider when an alternative is
   within both the utility and quality floors. With a single provider,
   provider-aware diversity has no quota benefit and auto mode leaves each role
   on its independent winner. `quality` profile also keeps independent winners.
6. Builds an ordered fallback chain from the same eligible ranking. The chain
   skips cooling, unhealthy, probe-blocked, incompatible, or already-attempted
   models, and excludes every model from a provider under a provider-wide
   cooldown.
7. Keeps the current model when it matches the allocated primary. Existing
   session continuity is preserved without undoing cross-role allocation.
8. Switches with `session.switchModel()` before the prompt starts.
9. Stops routing for a session after a manual model selection, leaving that
   choice in place until a new session is started.

Scores and reasons are persisted. `opencode-free why` shows the full decision,
including alternatives, prior quality, evidence source, and the fallback chain.

### Failover chains

`status` shows the primary and its next fallbacks:

```text
plan  opencode/deepseek-v4.1-flash-free#high  …  best_score
      chain deepseek#high → glm#high → flint#medium
build opencode/glm-5.3-flash-free#low         …  role_diversity
      chain glm#low → deepseek#low → flint#medium
```

`opencode-free scores` prints every candidate's cached inputs: utility, final
quality, public prior, evidence source, reliability, speed, live sample count,
health, and chain position. Add `--json` for the complete structure.

Chains are computed from current health each time; they are not a permanently
cached static list. Active model-local rate limits move the affected model into
cooldown and the next prompt starts with the next eligible chain member. A
provider-wide limit removes the entire provider from consideration.

OpenCode is configured as a **provider-scoped** limit by default. A rate limit
or quota failure recorded on any OpenCode model cools down the whole `opencode`
provider, so the model chain is not retried pointlessly within that provider.
Failover proceeds only to another configured provider with independent free
capacity. With OpenCode as the only provider, routing stops until the provider
cooldown expires instead of cycling through DeepSeek, GLM, Flint, and the rest.

`limitScopes` controls this per provider:

```json
{
  "limitScopes": {
    "opencode": "provider",
    "another-gateway": "model"
  }
}
```

Rate-limit and quota errors use the configured scope. Timeouts, invalid output,
and other model-specific errors still allow fallback within the same provider.
Provider diversity reduces pressure only when the providers have independent
limits. It cannot create capacity for an account-wide or provider-wide quota;
when every eligible provider is cooling down, routing still stops.

### Failover

Provider retries are intercepted. On rate limits, free/quota limits, timeouts,
transport errors, 5xx responses, invalid output, unsupported requests, or
content filters, the router:

1. Records the failure and enters a cooldown tuned to the error. `Retry-After`
   is respected when supplied. Rate-limit and quota errors use the configured
   provider or model scope.
2. Excludes that model from the current retry chain; provider-scoped failures
   exclude every model from that provider.
3. Selects the next eligible free provider/model and switches the same OpenCode
   session. There is no same-provider cycling after a provider-wide limit.
4. Allows OpenCode to retry the interrupted request. Completed tool calls are
   never replayed.
5. Stops after the configured failover budget or when no candidate is healthy.
   With one provider, a provider-wide limit therefore stops immediately and
   exposes the retry time.

A response watchdog fails a request after 90 seconds without its first chunk or
90 seconds between chunks. OpenCode then retries through the same failover path.
These thresholds and cooldowns are configurable in `settings.json`.

A user abort is not treated as a model failure. Authentication, privacy, and
content-policy failures are not bypassed or retried across models indefinitely.

## Quality model

Quality comes from a versioned, offline registry of public-benchmark-derived
family estimates. Sources include official model cards and technical reports,
plus public evaluations such as SWE-bench Verified, GPQA Diamond, tau-bench,
IFEval, and IFBench. The registry records source URLs and evidence dates.

The registry maps exact provider endpoints to a canonical model family. A model
served by both OpenCode and OpenRouter therefore receives the same public prior
without user configuration. Matches are explicit and reviewed: the router never
guesses identity from a fuzzy name or assigns scores across different model
versions.

Raw benchmark percentages are not used directly as quality. Each benchmark is
normalized against a practical floor and ceiling on a linear scale. Static coding
evidence such as LiveCodeBench is kept separate from repository-level agentic
coding, receives a smaller role weight, and is capped. Missing dimensions stay
neutral instead of being renormalized upward:

- `plan` weights reasoning most heavily.
- `build` weights agentic coding and tool use most heavily.
- `verify` balances reasoning and coding.
- `fast` weights tool use, instruction following, and lighter coding evidence.

Unmapped endpoints use the median mapped public prior for the requested role.
They remain eligible for normal routing. A small exploration quota also assigns
them an occasional normal session so an unknown model is not permanently excluded.
The decision is made once per session and recorded with reason
`explore_unmapped`. Exploration affects participation, not quality: successful
requests teach reliability and speed, not coding quality.

`qualityPriors` remains available as an advanced exact endpoint override. It is
not required for known model families. `opencode-free priors` shows families,
endpoint matches, raw evidence, calibrated role scores, and optional overrides.

**Probe details:** `probe` sends one single-turn, no-tool request asking for
exactly `ok`. It records availability, response status, and duration. It does not
measure planning or coding quality. Provider quota and rate-limit failures still
enter the normal cooldown path. Fresh probe failures are temporary availability
signals; when every candidate fails, routing falls back to public priors rather
than treating the entire catalog as unusable.

Free models can change behind a stable ID. The catalog fingerprint triggers
rediscovery when free models rotate. Treat public priors as estimates for the
model family, not guarantees about a specific endpoint's quantization, tool-call
parsing, queueing, or rate limits.

## Configuration

Settings live in `~/.local/state/opencode-free/settings.json`. Important options:

```json
{
  "auto": true,
  "profile": "balanced",
  "providers": ["*"],
  "excludeProviders": [],
  "excludeModels": [],
  "pinnedModels": {},
  "qualityPriors": {},
  "limitScopes": {
    "opencode": "provider"
  },
  "maxFailovers": 3,
  "rateLimitCooldownMs": 60000,
  "quotaCooldownMs": 1800000,
  "slow": {
    "firstChunkMs": 90000,
    "idleChunkMs": 90000
  },
  "routing": {
    "diversity": "auto",
    "overlapPenalty": 0.04,
    "maxPrimaryScoreLoss": 0.04,
    "maxQualityLoss": 0.03,
    "exploreUnmapped": {
      "plan": 0.02,
      "build": 0.02,
      "verify": 0.02,
      "fast": 0.05
    }
  },
  "probe": {
    "onAssign": true,
    "timeoutMs": 10000,
    "concurrency": 2,
    "candidatesPerRole": 4,
    "successTtlMs": 3600000,
    "failureTtlMs": 600000,
    "accessFailureTtlMs": 21600000
  }
}
```

`routing.exploreUnmapped` is the probability that a new session receives an
unmapped model for each role. Set it to a single number from 0 to 1 to use the
same rate everywhere, or to `0` to disable exploration. The least-used healthy
unmapped endpoint is selected, preferring one that has not been explored
recently. The choice persists for the session.

`probe.onAssign` enables the automatic preflight before launch. Set it to `false`
to restore strictly network-free assignment. `probe.candidatesPerRole` controls
how many ranked candidates from each primary role enter the pool.
`probe.timeoutMs` and `probe.concurrency` bound startup time.

`successTtlMs` defaults to one hour, `failureTtlMs` to ten minutes, and
`accessFailureTtlMs` to six hours. Probe latency can influence the speed portion
of routing when it is fresher or more pessimistic than historical live traffic,
but it never affects quality or reliability.

`routing.diversity` accepts `"auto"`, `true`, or `false`. `"auto"` enables
provider-aware diversity for `balanced` and `fast` only when multiple providers
have eligible models, and disables it for `quality`. Explicit `true` retains
model-level diversity within one provider for users who want role
specialization rather than quota relief.
`overlapPenalty` is the utility penalty for assigning a provider already used as
another role's primary (or a model when diversity is explicitly `true`).
`maxPrimaryScoreLoss` and `maxQualityLoss` bound how much utility or effective
quality an alternative may give up. Role allocation is ordered plan, build,
verify, fast, and pins are always fixed.

`qualityPriors` accepts exact `provider/model` overrides. Each entry can provide
`reasoning`, `coding`, `codeGeneration`, `toolUse`, `instructionFollowing`, and
`confidence` from 0 to 1, or direct
`roles: { "plan": ..., "build": ... }` values:

```json
{
  "qualityPriors": {
    "opencode/big-pickle": {
      "reasoning": 0.74,
      "coding": 0.7,
      "toolUse": 0.72,
      "instructionFollowing": 0.76,
      "confidence": 0.6
    }
  }
}
```

`providers` defaults to `["*"]`, which includes every provider connected to
OpenCode. Paid models remain ineligible: a model must be genuinely zero-cost
across every price tier to enter the catalog. To restrict routing to specific
providers, replace the wildcard with an allowlist such as
`["opencode", "openrouter"]`. Verify each provider's terms and privacy policy
before allowing its free models to receive prompts.

A zero-cost catalog entry does not necessarily mean a model is free of
subscription usage. Some providers expose subscription-backed models with zero
per-token prices, and their quota cannot be detected reliably from model
metadata. Exclude those providers explicitly:

```bash
opencode-free ignore-provider subscription-provider
opencode-free allow-provider subscription-provider
```

This writes `excludeProviders` in `settings.json`. Provider exclusions take
precedence over both wildcard discovery and an explicit `providers` allowlist.
Use `excludeModels`/`ignore` when only particular subscription-backed models
should be excluded.

## Relay

When Relay's agents are installed, the router recognizes `planner`,
`implementer`, `verifier`, `watcher`, and `orchestrator` automatically:

- planner: quality planning
- implementer: balanced build
- verifier/watcher: quality verification
- orchestrator: fast/tool-reliable

Relay is optional. The router works with OpenCode's built-in Plan and Build
without Relay. Some free models reject agents that deny `read` or `shell`, so
Relay's planner permissions may need to allow those tools while keeping edits
disabled.

## Privacy and safety

- Availability probes send only the fixed text `Reply with exactly: ok`.
- Only routing metadata, error categories, timings, and token counts are stored
  by default. Prompt text and source code are not logged.
- No paid model is eligible, including for automatic fallback.
- Free models have different retention and training policies. Use
  `excludeModels`/`ignore` for individual models and
  `excludeProviders`/`ignore-provider` for entire providers.

If OpenCode reports an account-wide free usage limit, routing cannot manufacture
more quota. The plugin cools down the failed route and stops when no eligible
model remains.

## Development

```bash
npm test
npm run check
OPENCODE_FREE_HOME=$(mktemp -d) node bin/opencode-free.js scan
OPENCODE_FREE_HOME=$(mktemp -d) node bin/opencode-free.js probe --model opencode/beam-free
```

The tests use mocked OpenCode hooks and do not make model requests. Probe helpers
are tested directly; the launcher tests use a local stub executable.

## Package status

This is a local, npm-ready package (`bin` and plugin export included). It is not
published to npm yet. Running the CLI through `node bin/opencode-free.js` is
the lightest setup; `npm link` is optional convenience for the CLI command.
