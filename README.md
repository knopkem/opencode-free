# opencode-free

Automatic model selection, health tracking, and failover for OpenCode's free
models.

[![npm](https://img.shields.io/npm/v/@knopkem/opencode-free.svg)](https://www.npmjs.com/package/@knopkem/opencode-free)
[![license](https://img.shields.io/npm/l/@knopkem/opencode-free.svg)](LICENSE)
[![node](https://img.shields.io/node/v/@knopkem/opencode-free.svg)](package.json)

`opencode-free` discovers zero-cost models from the model catalog, ranks them
using public benchmark priors plus live reliability and speed, and assigns the
best healthy model to each role. It never falls back to a paid model: when no
free route is available, it stops with a clear cooldown.

## Requirements

- OpenCode **2.x** with the V2 plugin API (tested with `2.2.5`).
- Node.js **22** or newer.
- Free models available in your OpenCode account. No paid subscription is
  required, but free-model availability, region, retention, and limits are
  controlled by OpenCode.

## Install

```bash
npm install --global @knopkem/opencode-free
opencode plugin add @knopkem/opencode-free
```

Restart OpenCode after adding the plugin. The global install provides the
`opencode-free` and `ocf` commands; `opencode plugin add` registers the plugin
with OpenCode.

Start OpenCode through the launcher:

```bash
ocf
```

The first launch discovers the current free catalog automatically. To inspect
what was found first, run:

```bash
opencode-free init
```

`init` makes **no model requests**. It writes settings and the catalog under:

```text
~/.local/state/opencode-free/
```

Use `OPENCODE_FREE_HOME` to keep a separate state directory.

## Quick start

```bash
ocf                              # start OpenCode with routed models
ocf run "Fix the failing tests"  # pass arguments through to OpenCode
ocf status                       # show routes, health, and cooldowns
```

`ocf` launches OpenCode unless its first argument is a management command, in
which case it runs that command. `opencode-free opencode [args...]` is the
explicit equivalent.

The launcher writes model assignments only into the child OpenCode process
through `OPENCODE_CONFIG_CONTENT`. It does not permanently edit global or
project configuration, and it preserves unrelated agent settings. The plugin
continues to handle live routing and failover, so a long-running session can
move to another healthy free model as conditions change.

Automatic routing applies until you manually choose a model in a session. That
choice then sticks for the rest of the session, whether it is free or paid.
Start a new session to resume automatic routing.

## How routing works

Each prompt is assigned one of four roles:

| Role | Used for |
|---|---|
| `plan` | OpenCode Plan and planning-focused custom agents |
| `build` | OpenCode Build and general implementation agents |
| `verify` | Verification, review, and audit agents |
| `fast` | Exploration, orchestration, and lightweight agents |

OpenCode's `title`, `summary`, and `compaction` agents are never rerouted.

The router:

1. **Filters candidates.** A model must be enabled, chat-capable,
   tool-capable, genuinely zero-cost, allowed by provider filters, not
   excluded, healthy, and image-compatible when the prompt contains images.
2. **Probes stale candidates before assignment.** A short availability check
   temporarily removes models that just failed.
3. **Selects a role-appropriate variant**, such as `high` reasoning for
   planning and `medium` or `low` for faster building.
4. **Scores candidates** using public quality priors, observed reliability,
   recent latency and throughput, fresh probe latency, and the active profile.
5. **Balances provider diversity** in `balanced` and `fast` profiles when
   multiple providers have eligible models. Planning keeps the strongest
   candidate; later roles avoid reusing that provider when an alternative is
   close enough on both utility and quality.
6. **Builds a fallback chain** from the same ranking, skipping cooling,
   unhealthy, incompatible, or already-attempted models.
7. **Switches models with `session.switchModel()`** before the prompt starts.

Unmapped models receive the median mapped prior for the role and remain
eligible. A small exploration quota occasionally assigns them a normal session
so an unknown model is not permanently shut out. Exploration affects
participation, not quality: it never changes coding-quality scores.

### Availability probes

`probe` sends one single-turn, no-tool request asking for exactly `ok`. It
records availability, response status, and latency only. It does not measure
planning or coding quality and does not change the quality score.

- Successful probes are cached for one hour.
- Ordinary failures expire after ten minutes.
- Access failures expire after six hours.
- Fresh failures temporarily remove a model from assignment.
- Probe latency acts as a low-confidence speed signal.
- If every candidate is unavailable, routing falls back to public priors
  instead of refusing to start.

With `probe.onAssign` enabled by default, the launcher probes stale assignment
candidates before routing. Set it to `false` for strictly network-free
assignment.

```bash
opencode-free probe                          # probe stale assignment candidates
opencode-free probe --all                    # inventory every free model
opencode-free probe --model opencode/beam-free --refresh
```

`benchmark` and `bench` are aliases for `probe`. `--full` is rejected because
local quality benchmarking was removed.

If a provider-wide rate limit or quota error occurs, probing stops scheduling
models for that provider, records the cooldown for normal routing, and reports
the remaining models as skipped instead of burning quota through model-by-model
retries.

### Failover

On rate limits, quota errors, timeouts, transport errors, 5xx responses,
invalid output, unsupported requests, or content filters, the router:

1. Records the failure and enters a cooldown tuned to the error. `Retry-After`
   is respected when supplied.
2. Excludes the failed model, or the whole provider for provider-scoped
   failures, from the current retry chain.
3. Selects the next eligible free model and switches the same OpenCode session.
4. Lets OpenCode retry the interrupted request. Completed tool calls are never
   replayed.
5. Stops after the configured failover budget or when no candidate is healthy.

Chains are rebuilt from current health each time. A response watchdog fails a
request after 90 seconds without its first chunk or 90 seconds between chunks,
after which OpenCode retries through the normal failover path. User aborts are
not treated as model failures.

OpenCode is configured as a **provider-scoped** limit by default. A rate limit
or quota failure on any OpenCode model cools down the whole `opencode` provider,
so the chain is not retried pointlessly within that provider. Failover proceeds
only to another provider with independent free capacity. With OpenCode as the
only provider, routing stops until the provider cooldown expires.

Control this per provider with `limitScopes`:

```json
{
  "limitScopes": {
    "opencode": "provider",
    "another-gateway": "model"
  }
}
```

Timeouts and other model-specific errors still allow fallback within the same
provider. Provider diversity cannot create capacity for an account-wide quota;
when every eligible provider is cooling down, routing stops.

### Profiles

| Profile | Best for |
|---|---|
| `quality` | Highest-quality planning and review |
| `balanced` | Default mix of quality, reliability, and speed |
| `fast` | Lower latency and quicker builds |

Change the profile with:

```bash
opencode-free profile quality
opencode-free profile balanced
opencode-free profile fast
```

## Commands

| Command | Purpose |
|---|---|
| `opencode-free opencode [args...]` | Start OpenCode with routed agent models |
| `opencode-free init` | Discover models and initialize settings |
| `opencode-free scan` | Refresh the free-model catalog |
| `opencode-free probe` | Check availability with one request per selected model |
| `opencode-free status` | Show recommendations, pins, health, cooldowns, and the last route |
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

Most commands accept `--json` for scripting. Run `opencode-free help` for the
full CLI reference.

## Quality model

Quality comes from a versioned, offline registry of public-benchmark-derived
family estimates. Sources include official model cards and technical reports,
plus public evaluations such as SWE-bench Verified, GPQA Diamond, tau-bench,
IFEval, and IFBench. The registry records source URLs and evidence dates.

The registry maps exact provider endpoints to a canonical model family. A model
served by both OpenCode and another gateway therefore receives the same public
prior without extra configuration. Matches are explicit and reviewed: the
router never guesses identity from a fuzzy name or transfers scores across
different model versions.

Raw benchmark percentages are not used directly. Each benchmark is normalized
against a practical floor and ceiling, and role weights reflect what matters for
each job:

- `plan` weights reasoning most heavily.
- `build` weights agentic coding and tool use most heavily.
- `verify` balances reasoning and coding.
- `fast` weights tool use, instruction following, and lighter coding evidence.

Static coding evidence such as LiveCodeBench is kept separate from
repository-level agentic coding, receives a smaller role weight, and is capped.
Missing dimensions stay neutral instead of being renormalized upward.

`opencode-free priors` shows families, endpoint matches, raw evidence,
calibrated role scores, and optional overrides. Free models can change behind a
stable ID, so treat public priors as estimates for the model family, not
guarantees about a specific endpoint's quantization, tool-call parsing,
queueing, or rate limits.

## Configuration

Settings live in `~/.local/state/opencode-free/settings.json`.

Common options:

| Option | Default | Purpose |
|---|---|---|
| `auto` | `true` | Enable automatic routing |
| `profile` | `"balanced"` | `quality`, `balanced`, or `fast` |
| `providers` | `["*"]` | Providers allowed to supply free models |
| `excludeProviders` | `[]` | Providers excluded from routing |
| `excludeModels` | `[]` | Individual models excluded from routing |
| `pinnedModels` | `{}` | Role pins |
| `limitScopes` | `{ "opencode": "provider" }` | Rate-limit scope per provider |
| `maxFailovers` | `3` | Retry budget per prompt |
| `probe.onAssign` | `true` | Probe stale candidates before routing |
| `routing.diversity` | `"auto"` | Provider-aware diversity (`"auto"`, `true`, `false`) |
| `routing.exploreUnmapped` | per-role | Probability of assigning an unmapped model |

### Provider allowlists and exclusions

`providers` defaults to `["*"]`, which includes every provider connected to
OpenCode. To restrict routing, use an explicit allowlist:

```json
{
  "providers": ["opencode", "openrouter"]
}
```

Verify each provider's terms and privacy policy before allowing its free models
to receive prompts. Provider exclusions take precedence over the wildcard and
over an explicit allowlist:

```bash
opencode-free ignore-provider subscription-provider
opencode-free allow-provider subscription-provider
```

Some providers expose subscription-backed models with zero per-token prices,
and their quota cannot be detected reliably from model metadata. Exclude those
providers explicitly.

### Quality overrides

`qualityPriors` is available as an advanced exact-endpoint override. It is not
required for known model families. Each entry can provide `reasoning`,
`coding`, `codeGeneration`, `toolUse`, `instructionFollowing`, and `confidence`
from 0 to 1, or direct `roles` values:

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

### Full defaults

<details>
<summary>Show all default settings</summary>

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
  "serverCooldownMs": 30000,
  "unknownCooldownMs": 15000,
  "speed": {
    "targetTtftMs": 8000,
    "targetTps": 40
  },
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

</details>

`routing.exploreUnmapped` can also be a single number from 0 to 1 to use the
same rate for every role, or `0` to disable exploration. The least-used healthy
unmapped endpoint is selected, preferring one that has not been explored
recently. The choice persists for the session.

## Privacy and safety

- Availability probes send only the fixed text `Reply with exactly: ok`.
- Only routing metadata, error categories, timings, and token counts are stored
  by default. Prompt text and source code are not logged.
- No paid model is eligible, including for automatic fallback.
- Free models have different retention and training policies. Use
  `opencode-free ignore` for individual models and
  `opencode-free ignore-provider` for entire providers.
- If OpenCode reports an account-wide free usage limit, routing cannot create
  more quota. The plugin cools down the failed route and stops when no eligible
  model remains.

## Development

```bash
npm install
npm test
npm run check
```

You can also exercise the CLI without touching your normal state:

```bash
OPENCODE_FREE_HOME=$(mktemp -d) node bin/opencode-free.js scan
OPENCODE_FREE_HOME=$(mktemp -d) node bin/opencode-free.js probe --model opencode/beam-free
```

For local plugin development, link the checkout and install the symlink:

```bash
npm link
opencode-free install
```

The tests use mocked OpenCode hooks and do not make model requests. Probe helpers
are tested directly; the launcher tests use a local stub executable.

## License

[MIT](LICENSE)
