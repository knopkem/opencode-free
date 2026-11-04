# opencode-free

Automatic model selection, health tracking, and failover for OpenCode's free
models. It discovers zero-cost models by catalog metadata rather than by name,
benchmarks planning and coding quality in isolated fixtures, and routes each
role to the best currently healthy model.

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
node bin/opencode-free.js install
node bin/opencode-free.js init
```

Restart OpenCode after `install`. The command creates one symlink at
`~/.config/opencode/plugins/opencode-free.js` (or the directory selected by
`OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME`). It refuses to overwrite anything it
does not own. This is the only installation needed for the plugin.

To get the shorter `opencode-free` command without copying the package, add an
alias to your shell profile:

```bash
alias opencode-free='node /Users/macair/projects/opencode-free/bin/opencode-free.js'
```

Alternatively, use `npm link` instead of `npm install -g .`. `npm link` creates
a global command symlink pointing back to this checkout, so changes are picked
up automatically:

```bash
npm link
opencode-free status
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
opencode-free benchmark --quick
opencode-free status
```

Then open OpenCode and use Plan or Build normally. Any session currently using a
zero-cost model is eligible for routing. A session manually switched to a paid
model is left alone.

The first benchmark sends one small planning task and one small coding task to
each free model. It uses synthetic fixtures only, never your source code.

Quick mode runs up to three models in parallel and has a **60-second hard cap per
case**. Full mode repeats the fixtures serially so latency measurements are not
distorted by contention. A model that exceeds the cap or scores below the
minimum quality threshold is marked disqualified for that role and is not
selected until a later benchmark clears it.

```bash
opencode-free benchmark --quick --concurrency 4
opencode-free benchmark --full --timeout 90000
opencode-free benchmark --model opencode/beam-free --refresh
```

Results are cached for 24 hours and invalidated when the free-model catalog
changes. `--refresh` forces a rerun. A model named explicitly with `--model` is
always rerun. If a benchmark is interrupted, the next run resumes only models
missing fresh results.

## Commands

| Command | Purpose |
|---|---|
| `opencode-free install` | Install the plugin symlink; safe to rerun |
| `opencode-free uninstall` | Remove only the symlink owned by this package |
| `opencode-free init` | Discover models and initialize settings |
| `opencode-free scan` | Refresh the free-model catalog |
| `opencode-free benchmark [--quick\|--full]` | Measure quality, capabilities, latency, and throughput |
| `opencode-free status` | Show recommendations, pins, health, cooldowns, and last route |
| `opencode-free why` | Print the last routing decision with scores |
| `opencode-free pin plan opencode/model#variant` | Pin one role |
| `opencode-free unpin build` | Remove a role pin |
| `opencode-free profile quality\|balanced\|fast` | Change routing weights |
| `opencode-free auto` / `off` | Enable or disable routing |
| `opencode-free ignore provider/model` | Exclude a model |
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
2. Selects a role-appropriate model variant (for example `high` reasoning for
   quality planning, `medium` or `low` for faster building).
3. Scores candidates using benchmark quality and capability, observed
   reliability, recent latency/throughput, profile weights, and a small
   exploration allowance for unmeasured models.
4. Keeps the current model when it is close to the best score and healthy.
   This avoids unnecessary switching.
5. Switches with `session.switchModel()` before the prompt starts.

Scores and reasons are persisted. `opencode-free why` shows the full decision,
including alternatives.

### Failover

Provider retries are intercepted. On rate limits, free/quota limits, timeouts,
transport errors, 5xx responses, invalid output, unsupported requests, or
content filters, the router:

1. Records the failure and enters a cooldown tuned to the error. `Retry-After`
   is respected when supplied.
2. Excludes that model from the current retry chain.
3. Selects the next eligible free model and switches the same OpenCode session.
4. Allows OpenCode to retry the interrupted request. Completed tool calls are
   never replayed.
5. Stops after the configured failover budget or when no candidate is healthy.

A response watchdog fails a request after 90 seconds without its first chunk or
90 seconds between chunks. OpenCode then retries through the same failover path.
These thresholds and cooldowns are configurable in `settings.json`.

A user abort is not treated as a model failure. Authentication, privacy, and
content-policy failures are not bypassed or retried across models indefinitely.

## Quality model

Benchmarks run in temporary projects with separate OpenCode sessions:

- **Planning:** inspect a repository, diagnose a known defect, and return a
  structured minimal fix. Score rewards correct diagnosis, exact fix, valid
  JSON, and no edits.
- **Building:** repair a failing implementation with tools. The score consists
  of restored visible tests and hidden tests added after the model finishes.
- **Capabilities:** a run must complete and produce useful output; tool use and
  image routing are hard gates based on advertised and observed support.
- **Performance:** first-output latency, wall duration, output tokens, reasoning
  tokens, and throughput are recorded from live requests.

Errors are kept separate from quality. A rate-limited run lowers reliability and
places the model in cooldown; it is not scored as bad code.

Free models can change behind a stable ID. Benchmark history is therefore
versioned by model ID and variant, and the catalog fingerprint triggers
rediscovery when free models rotate. Rerun benchmarks periodically or when
`opencode-free status` shows a model behaving differently.

## Configuration

Settings live in `~/.local/state/opencode-free/settings.json`. Important options:

```json
{
  "auto": true,
  "profile": "balanced",
  "providers": ["opencode"],
  "excludeModels": [],
  "pinnedModels": {},
  "maxFailovers": 3,
  "rateLimitCooldownMs": 60000,
  "quotaCooldownMs": 1800000,
  "slow": {
    "firstChunkMs": 90000,
    "idleChunkMs": 90000
  },
  "benchmark": {
    "quickTimeoutMs": 60000,
    "fullTimeoutMs": 180000,
    "quickConcurrency": 3,
    "fullConcurrency": 1,
    "fullRepetitions": 2,
    "cacheTtlMs": 86400000,
    "minQuality": 0.2
  }
}
```

`providers` defaults to `opencode`, which is the zero-cost OpenCode catalog.
Other providers can be added only if their catalog entries are genuinely
zero-cost across every price tier. This is useful for other free gateways, but
verify their terms and privacy before enabling them.

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

- Benchmarks use synthetic files and prompts. User code is never sent to a judge.
- Only routing metadata, error categories, timings, and token counts are stored
  by default. Prompt text and source code are not logged.
- Build benchmarks run in disposable temporary directories.
- No paid model is eligible, including for automatic fallback.
- Free models have different retention and training policies. Use
  `excludeModels`/`ignore` for anything you do not want a model to receive.

If OpenCode reports an account-wide free usage limit, routing cannot manufacture
more quota. The plugin cools down the failed route and stops when no eligible
model remains.

## Development

```bash
npm test
npm run check
OPENCODE_FREE_HOME=$(mktemp -d) node bin/opencode-free.js scan
OPENCODE_FREE_HOME=$(mktemp -d) node bin/opencode-free.js benchmark --quick --model opencode/beam-free
```

The tests use mocked OpenCode hooks and do not make model requests. The benchmark
command has a real end-to-end test path against a local `opencode serve`
instance.

## Package status

This is a local, npm-ready package (`bin` and plugin export included). It is not
published to npm yet. Running the CLI through `node bin/opencode-free.js` is
the lightest setup; `npm link` is optional convenience for the CLI command.
