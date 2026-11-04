import { benchmark, discoverFreeModels } from "./benchmark.js"
import { modelKey, parseKey } from "./catalog.js"
import { ROLES } from "./constants.js"
import { healthStats, effectiveState } from "./health.js"
import { installPlugin, uninstallPlugin } from "./install.js"
import { chooseModel } from "./router.js"
import {
  loadBenchmarks,
  loadSettings,
  loadState,
  saveSettings,
  statePaths,
} from "./state.js"

const HELP = `opencode-free — automatic free-model routing for OpenCode

Usage:
  opencode-free install                 Install the OpenCode plugin symlink
  opencode-free uninstall               Remove the plugin symlink
  opencode-free init                    Discover free models and create settings
  opencode-free scan [--json]           Refresh the free-model catalog
  opencode-free benchmark [options]     Run isolated quality/performance checks
  opencode-free status [--json]         Show routes, health, cooldowns, and benchmarks
  opencode-free why [--json]            Explain the latest routing decision
  opencode-free pin <role> <model>      Pin a model for plan/build/verify/fast
  opencode-free unpin <role>            Remove a role pin
  opencode-free profile <name>          Set quality | balanced | fast
  opencode-free auto                    Enable automatic routing
  opencode-free off                     Disable automatic routing
  opencode-free ignore <model>          Exclude a model from routing
  opencode-free config                  Print settings and state locations

Benchmark options:
  --quick                 One planning and one build case per model (default)
  --full                  Repeat the suite with serial latency measurements
  --model <provider/id>   Benchmark only this model (repeatable)
  --timeout <ms>          Hard per-case timeout
  --concurrency <n>       Cases run in parallel (quick default: 3)
  --refresh               Ignore fresh cached results and rerun

Environment:
  OPENCODE_FREE_HOME      Override the state directory
`

export async function runCli(argv = process.argv.slice(2), io = console) {
  const [command = "help", ...rest] = argv
  const json = rest.includes("--json")
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      io.log(HELP)
      return 0
    case "--version":
    case "version":
      io.log("0.1.0")
      return 0
    case "install":
      return install(io, json)
    case "uninstall":
      return uninstall(io, json)
    case "init":
      return init(io, json)
    case "scan":
      return scan(io, json)
    case "benchmark":
    case "bench":
      return runBenchmark(io, rest, json)
    case "status":
      return status(io, json)
    case "why":
      return why(io, json)
    case "pin":
      return pin(io, rest, json)
    case "unpin":
      return unpin(io, rest, json)
    case "profile":
      return profile(io, rest, json)
    case "auto":
      return setAuto(io, true, json)
    case "off":
      return setAuto(io, false, json)
    case "ignore":
      return ignore(io, rest, json)
    case "config":
      return config(io, json)
    default:
      io.error(`Unknown command: ${command}\n`)
      io.error(HELP)
      return 2
  }
}

async function install(io, json) {
  const result = await installPlugin()
  if (json) io.log(JSON.stringify(result, null, 2))
  else {
    io.log(`${result.changed ? "Installed" : "Already installed"}: ${result.target}`)
    io.log("Restart OpenCode, then run `opencode-free init`.")
  }
  return 0
}

async function uninstall(io, json) {
  const result = await uninstallPlugin()
  if (json) io.log(JSON.stringify(result, null, 2))
  else {
    io.log(result.removed ? `Removed ${result.target}` : `Not installed: ${result.target}`)
    io.log("Restart OpenCode to unload the plugin.")
  }
  return 0
}

async function init(io, json) {
  const settings = await saveSettings(await loadSettings())
  const catalog = await discoverFreeModels()
  const output = {
    settings: statePaths().settings,
    state: statePaths().state,
    models: catalog.models.map(modelSummary),
    count: catalog.models.length,
  }
  if (json) io.log(JSON.stringify(output, null, 2))
  else {
    io.log(`Initialized opencode-free at ${statePaths().home}`)
    io.log(`Found ${catalog.models.length} zero-cost chat model(s):`)
    printModels(io, catalog.models)
    io.log("")
    io.log("Automatic routing is enabled. Select any free model in OpenCode, or keep using a free default.")
    io.log("Run `opencode-free benchmark --quick` to seed quality and latency scores.")
  }
  if (!settings.auto) io.log("Note: automatic routing is currently disabled (`opencode-free auto`).")
  return 0
}

async function scan(io, json) {
  const catalog = await discoverFreeModels()
  if (json) {
    io.log(JSON.stringify(catalog, null, 2))
  } else {
    io.log(`Refreshed ${catalog.models.length} free model(s) at ${catalog.refreshedAt}`)
    printModels(io, catalog.models)
  }
  return 0
}

async function runBenchmark(io, args, json) {
  const quick = !args.includes("--full")
  const models = valuesFor(args, "--model")
  const timeout = valueFor(args, "--timeout")
  const concurrency = valueFor(args, "--concurrency")
  const result = await benchmark({
    quick,
    models,
    timeoutMs: timeout ? Number(timeout) : undefined,
    concurrency: concurrency ? Number(concurrency) : undefined,
    refresh: args.includes("--refresh"),
    onProgress: (message) => {
      if (!json) io.log(message)
    },
  })
  if (json) {
    io.log(JSON.stringify(result, null, 2))
    return 0
  }
  io.log("")
  io.log(
    `Benchmarked ${result.benchmarked.length} model(s)` +
      (result.reused ? `, reused ${result.reused} fresh cached result(s)` : "") +
      ` · concurrency ${result.concurrency} · ${Math.round(result.timeoutMs / 1000)}s cap`,
  )
  io.log("Benchmark summaries:")
  const roles = Object.keys(result.summaries || {})
  for (const role of roles) {
    io.log(`\n${role.toUpperCase()}`)
    for (const summary of Object.values(result.summaries[role]).sort(byQuality)) {
      io.log(
        `  ${summary.model.padEnd(42)} quality ${fmt(summary.quality)}  ` +
          `capability ${fmt(summary.capability)}  latency ${fmtMs(summary.ttftMs)}  ` +
          `speed ${fmtTps(summary.tps)}  samples ${summary.samples}` +
          (summary.disqualified ? `  DISQUALIFIED: ${summary.disqualifyReason}` : ""),
      )
    }
  }
  io.log("")
  io.log("Run `opencode-free status` to see the resulting routes.")
  return 0
}

async function status(io, json) {
  const [settings, state, benchmarks] = await Promise.all([
    loadSettings(),
    loadState(),
    loadBenchmarks(),
  ])
  const recommendations = {}
  if (state.catalog?.models?.length) {
    for (const role of ROLES) {
      const result = chooseModel({
        catalog: state.catalog,
        state,
        benchmarks,
        settings,
        role,
      })
      recommendations[role] = {
        key: result.candidate ? modelKey(result.candidate) : undefined,
        reason: result.decision.reason,
        score: result.decision.score,
        quality: result.decision.quality,
        reliability: result.decision.reliability,
        health: result.decision.health,
        alternatives: (result.alternatives || []).slice(0, 2).map((item) => ({
          key: item.key,
          score: item.score,
        })),
      }
    }
  }
  const output = {
    settings,
    paths: statePaths(),
    catalog: {
      refreshedAt: state.catalog?.refreshedAt,
      count: state.catalog?.models?.length || 0,
    },
    recommendations,
    health: Object.fromEntries(
      Object.entries(state.health || {}).map(([key, value]) => [
        key,
        {
          ...healthStats(value),
          state: effectiveState(value),
        },
      ]),
    ),
    lastRoute: state.lastRoute,
    benchmarkUpdatedAt: benchmarks.updatedAt,
  }
  if (json) {
    io.log(JSON.stringify(output, null, 2))
    return 0
  }
  io.log(`opencode-free ${settings.auto ? "AUTO" : "OFF"} · profile ${settings.profile}`)
  io.log(`Catalog: ${output.catalog.count} free models · refreshed ${output.catalog.refreshedAt || "never"}`)
  io.log(`State: ${statePaths().home}`)
  if (settings.pinnedModels && Object.keys(settings.pinnedModels).length) {
    io.log(`Pins: ${JSON.stringify(settings.pinnedModels)}`)
  }
  if (!state.catalog?.models?.length) {
    io.log("No catalog yet. Run `opencode-free init` or `opencode-free scan`.")
    return 0
  }
  io.log("\nRecommended routes:")
  for (const role of ROLES) {
    const route = recommendations[role]
    const pinned = settings.pinnedModels?.[role]
    io.log(
      `  ${role.padEnd(7)} ${(route.key || "none").padEnd(48)} ` +
        `quality ${fmt(route.quality)}  reliability ${fmt(route.reliability)}  ${route.reason}` +
        (pinned ? " (pinned)" : ""),
    )
  }
  const heat = Object.entries(output.health).filter(
    ([, value]) => value.samples > 0 || value.state !== "unknown",
  )
  if (heat.length) {
    io.log("\nLive health:")
    for (const [key, value] of heat.sort()) {
      io.log(
        `  ${key.padEnd(48)} ${value.state.padEnd(9)} ` +
          `reliability ${fmt(value.reliability)}  ttft ${fmtMs(value.ttftMs)}  samples ${value.samples}` +
          (value.cooldownUntil > Date.now()
            ? `  cooldown ${Math.ceil((value.cooldownUntil - Date.now()) / 1000)}s`
            : ""),
      )
    }
  }
  if (state.lastRoute) {
    io.log(
      `\nLast route: ${state.lastRoute.reason} · ` +
        `${state.lastRoute.previous || "initial"} -> ${state.lastRoute.candidate?.key || state.lastRoute.failed || "none"}`,
    )
  }
  return 0
}

async function why(io, json) {
  const state = await loadState()
  const decisions = state.decisions || []
  if (!decisions.length) {
    io.log("No routing decisions recorded yet.")
    return 0
  }
  const latest = decisions.at(-1)
  if (json) {
    io.log(JSON.stringify(latest, null, 2))
    return 0
  }
  io.log(JSON.stringify(latest, null, 2))
  return 0
}

async function pin(io, args, json) {
  const [role, model] = args.filter((value) => !value.startsWith("--"))
  if (!ROLES.includes(role) || !model) {
    io.error("Usage: opencode-free pin <plan|build|verify|fast> <provider/model[#variant]>")
    return 2
  }
  const parsed = parseKey(model)
  if (!parsed) {
    io.error("Model must use provider/model or provider/model#variant")
    return 2
  }
  const settings = await loadSettings()
  settings.pinnedModels = { ...settings.pinnedModels, [role]: model }
  const saved = await saveSettings(settings)
  if (json) io.log(JSON.stringify({ pins: saved.pinnedModels }, null, 2))
  else io.log(`${role} pinned to ${model}`)
  return 0
}

async function unpin(io, args, json) {
  const [role] = args.filter((value) => !value.startsWith("--"))
  if (!ROLES.includes(role)) {
    io.error("Usage: opencode-free unpin <plan|build|verify|fast>")
    return 2
  }
  const settings = await loadSettings()
  const pins = { ...settings.pinnedModels }
  delete pins[role]
  settings.pinnedModels = pins
  const saved = await saveSettings(settings)
  if (json) io.log(JSON.stringify({ pins: saved.pinnedModels }, null, 2))
  else io.log(`${role} unpinned`)
  return 0
}

async function profile(io, args, json) {
  const [name] = args.filter((value) => !value.startsWith("--"))
  if (!["quality", "balanced", "fast"].includes(name)) {
    io.error("Usage: opencode-free profile <quality|balanced|fast>")
    return 2
  }
  const settings = await loadSettings()
  settings.profile = name
  const saved = await saveSettings(settings)
  if (json) io.log(JSON.stringify({ profile: saved.profile }, null, 2))
  else io.log(`Routing profile set to ${saved.profile}`)
  return 0
}

async function setAuto(io, enabled, json) {
  const settings = await loadSettings()
  settings.auto = enabled
  const saved = await saveSettings(settings)
  if (json) io.log(JSON.stringify({ auto: saved.auto }, null, 2))
  else io.log(`Automatic routing ${saved.auto ? "enabled" : "disabled"}`)
  return 0
}

async function ignore(io, args, json) {
  const [model] = args.filter((value) => !value.startsWith("--"))
  if (!model || !parseKey(model)) {
    io.error("Usage: opencode-free ignore <provider/model>")
    return 2
  }
  const settings = await loadSettings()
  settings.excludeModels = [...new Set([...settings.excludeModels, model.replace(/#.*$/, "")])]
  const saved = await saveSettings(settings)
  if (json) io.log(JSON.stringify({ excludeModels: saved.excludeModels }, null, 2))
  else io.log(`Excluded ${model}`)
  return 0
}

async function config(io, json) {
  const [settings, state, benchmarks] = await Promise.all([
    loadSettings(),
    loadState(),
    loadBenchmarks(),
  ])
  const output = {
    paths: statePaths(),
    settings,
    catalogCount: state.catalog?.models?.length || 0,
    benchmarkRuns: benchmarks.runs?.length || 0,
  }
  if (json) io.log(JSON.stringify(output, null, 2))
  else {
    io.log(`Settings: ${statePaths().settings}`)
    io.log(`State:    ${statePaths().state}`)
    io.log(`Bench:    ${statePaths().benchmarks}`)
    io.log(JSON.stringify(settings, null, 2))
  }
  return 0
}

function printModels(io, models) {
  for (const model of models) {
    const vision = model.capabilities.input.some((type) => type.startsWith("image")) ? "vision" : "text"
    const variants = model.variants?.length ? model.variants.join(",") : "default"
    io.log(
      `  ${`${model.providerID}/${model.id}`.padEnd(46)} ` +
        `${String(model.limit?.context || 0).padStart(8)} ctx  ${vision.padEnd(6)}  ${variants}`,
    )
  }
}

function modelSummary(model) {
  return {
    key: `${model.providerID}/${model.id}`,
    name: model.name,
    context: model.limit.context,
    vision: model.capabilities.input.some((type) => type.startsWith("image")),
    variants: model.variants,
    status: model.status,
  }
}

function valuesFor(args, name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1])
    else if (args[index].startsWith(`${name}=`)) values.push(args[index].slice(name.length + 1))
  }
  return values
}

function valueFor(args, name) {
  return valuesFor(args, name).at(-1)
}

function byQuality(a, b) {
  return (b.quality || 0) - (a.quality || 0)
}

function fmt(value) {
  return Number.isFinite(value) ? Number(value).toFixed(2) : "—"
}

function fmtMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : "—"
}

function fmtTps(value) {
  return Number.isFinite(value) ? `${Number(value).toFixed(1)} tok/s` : "—"
}
