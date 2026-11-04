import { discoverFreeModels, probe } from "./probe.js"
import { modelKey, parseKey } from "./catalog.js"
import { ROLES } from "./constants.js"
import { healthStats, effectiveState } from "./health.js"
import { installPlugin, uninstallPlugin } from "./install.js"
import { LauncherError, launchOpencode } from "./launcher.js"
import {
  QUALITY_PRIORS,
  priorForModel,
  publicQualitySummary,
} from "./quality.js"
import { chooseRoutes } from "./router.js"
import {
  loadProbes,
  loadSettings,
  loadState,
  saveSettings,
  statePaths,
} from "./state.js"

export const CLI_COMMANDS = new Set([
  "help",
  "--help",
  "-h",
  "version",
  "--version",
  "opencode",
  "install",
  "uninstall",
  "init",
  "scan",
  "probe",
  "benchmark",
  "bench",
  "status",
  "scores",
  "why",
  "priors",
  "pin",
  "unpin",
  "profile",
  "auto",
  "off",
  "ignore",
  "ignore-provider",
  "allow-provider",
  "config",
])

const HELP = `opencode-free — automatic free-model routing for OpenCode

Usage:
  opencode-free opencode [args...]      Start OpenCode with routed agent models
  opencode-free install                 Install the OpenCode plugin symlink
  opencode-free uninstall               Remove the plugin symlink
  opencode-free init                    Discover free models and create settings
  opencode-free scan [--json]           Refresh the free-model catalog
  opencode-free probe [options]         Check model availability with one request
  opencode-free status [--json]         Show routes, health, cooldowns, and probes
  opencode-free scores [--role plan]    Show cached quality inputs and fallback chains
  opencode-free why [--json]            Explain the latest routing decision
  opencode-free priors [--json]         Show public quality priors and overrides
  opencode-free pin <role> <model>      Pin a model for plan/build/verify/fast
  opencode-free unpin <role>            Remove a role pin
  opencode-free profile <name>          Set quality | balanced | fast
  opencode-free auto                    Enable automatic routing
  opencode-free off                     Disable automatic routing
  opencode-free ignore <model>          Exclude a model from routing
  opencode-free ignore-provider <id>    Exclude a provider from routing
  opencode-free allow-provider <id>     Remove a provider exclusion
  opencode-free config                  Print settings and state locations

Shortcut:
  ocf [args...]                         Start OpenCode unless args begin with a command above

Probe options:
  --all                   Probe every free model instead of assignment candidates
  --model <provider/id>   Probe only this model (repeatable)
  --timeout <ms>          Request timeout
  --concurrency <n>       Requests run in parallel (default: 2)
  --refresh               Ignore fresh cached probes and rerun

benchmark and bench are compatibility aliases for probe.
Probes only check availability and response latency; they do not measure quality.

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
    case "opencode":
      return opencode(io, rest)
    case "install":
      return install(io, json)
    case "uninstall":
      return uninstall(io, json)
    case "init":
      return init(io, json)
    case "scan":
      return scan(io, json)
    case "probe":
    case "benchmark":
    case "bench":
      return runProbe(io, rest, json)
    case "status":
      return status(io, json)
    case "scores":
      return scores(io, rest, json)
    case "why":
      return why(io, json)
    case "priors":
      return priors(io, json)
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
    case "ignore-provider":
      return ignoreProvider(io, rest, json)
    case "allow-provider":
      return allowProvider(io, rest, json)
    case "config":
      return config(io, json)
    default:
      io.error(`Unknown command: ${command}\n`)
      io.error(HELP)
      return 2
  }
}

async function opencode(io, args) {
  try {
    return await launchOpencode({
      args,
      onLog: (message) => io.log(message),
    })
  } catch (error) {
    if (error instanceof LauncherError) {
      io.error(`opencode-free: ${error.message}`)
      return 1
    }
    throw error
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
    models: catalog.models.map((model) => modelSummary(model, settings)),
    count: catalog.models.length,
  }
  if (json) io.log(JSON.stringify(output, null, 2))
  else {
    io.log(`Initialized opencode-free at ${statePaths().home}`)
    io.log(
      `Found ${catalog.models.length} zero-cost chat model(s) from ` +
        `${formatProviders(settings.providers, settings.excludeProviders)}:`,
    )
    printModels(io, catalog.models, settings)
    io.log("")
    io.log("Automatic routing is enabled. Select any free model in OpenCode, or keep using a free default.")
    io.log("Quality priors are active immediately; `init` made no model requests.")
    io.log("Only run `opencode-free probe` when you explicitly want to spend quota on availability checks.")
  }
  if (!settings.auto) io.log("Note: automatic routing is currently disabled (`opencode-free auto`).")
  return 0
}

async function scan(io, json) {
  const [settings, catalog] = await Promise.all([loadSettings(), discoverFreeModels()])
  if (json) {
    io.log(
      JSON.stringify(
        {
          ...catalog,
          models: catalog.models.map((model) => ({
            ...model,
            publicQuality: publicQualitySummary(model, settings),
          })),
        },
        null,
        2,
      ),
    )
  } else {
    io.log(
      `Refreshed ${catalog.models.length} free model(s) at ${catalog.refreshedAt}` +
        ` · providers: ${formatProviders(settings.providers, settings.excludeProviders)}`,
    )
    printModels(io, catalog.models, settings)
  }
  return 0
}

async function runProbe(io, args, json) {
  if (args.includes("--help") || args.includes("-h")) {
    io.log(HELP)
    return 0
  }
  const unsupported = ["--full", "--all-models", "--repeat", "--max-sessions"].find((flag) =>
    args.includes(flag) || args.some((value) => value.startsWith(`${flag}=`)),
  )
  if (unsupported) {
    io.error(
      `${unsupported} is no longer supported. Full quality benchmarking was removed; ` +
        "`opencode-free probe` only checks availability.",
    )
    return 2
  }
  const models = valuesFor(args, "--model")
  const timeout = valueFor(args, "--timeout")
  const concurrency = valueFor(args, "--concurrency")
  const result = await probe({
    models,
    all: args.includes("--all"),
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
  const probes = result.probes || []
  io.log(
    `Probed ${probes.length} model(s)` +
      (result.reused ? `, reused ${result.reused} fresh cached probe(s)` : "") +
      ` · ${result.ok || 0} ok` +
      (result.failed ? ` · ${result.failed} failed` : "") +
      (result.skipped?.length ? ` · ${result.skipped.length} skipped` : "") +
      ` · ${Math.round(result.timeoutMs / 1000)}s cap`,
  )
  if (probes.length) {
    io.log("Availability probes (no quality measurement):")
    for (const item of probes) {
      io.log(
        `  ${item.model.padEnd(48)} ` +
          (item.error
            ? `ERROR ${item.error.message}`
            : `${item.responseOk ? "ok" : "unexpected response"} ${Math.round(item.durationMs || 0)}ms`),
      )
    }
  }
  for (const skip of result.skipped || []) {
    io.log(`  ${skip.model.padEnd(48)} SKIPPED ${skip.reason}`)
  }
  io.log("")
  io.log("Routing still uses public priors plus live health, reliability, and speed.")
  return 0
}

async function status(io, json) {
  const [settings, state, probes] = await Promise.all([
    loadSettings(),
    loadState(),
    loadProbes(),
  ])
  const recommendations = {}
  let routing
  if (state.catalog?.models?.length) {
    routing = chooseRoutes({
      catalog: state.catalog,
      state,
      probes,
      settings,
    })
    for (const role of ROLES) {
      const result = routing.roles[role]
      recommendations[role] = {
        key: result.candidate ? modelKey(result.candidate) : undefined,
        reason: result.decision.reason,
        score: result.decision.score,
        quality: result.decision.quality,
        priorQuality: result.decision.priorQuality,
        qualitySource: result.decision.qualitySource,
        reliability: result.decision.reliability,
        health: result.decision.health,
        chain: (result.chain || []).map((item) => item.key),
        independentBest: result.decision.independentBest,
        scoreLoss: result.decision.scoreLoss,
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
    routing: routing
      ? {
          diversity: routing.diversity,
        }
      : undefined,
    recommendations,
    health: healthReport(state.health),
    providerHealth: healthReport(state.providerHealth),
    lastRoute: state.lastRoute,
    probeUpdatedAt: probes.updatedAt,
  }
  if (json) {
    io.log(JSON.stringify(output, null, 2))
    return 0
  }
  io.log(
    `opencode-free ${settings.auto ? "AUTO" : "OFF"} · profile ${settings.profile}` +
      (routing?.diversity?.enabled
        ? ` · diversity on (${routing.diversity.unit})`
        : ""),
  )
  io.log(`Catalog: ${output.catalog.count} free models · refreshed ${output.catalog.refreshedAt || "never"}`)
  io.log(`State: ${statePaths().home}`)
  io.log(`Limit scopes: ${formatLimitScopes(settings.limitScopes)}`)
  if (settings.excludeProviders.length) {
    io.log(`Excluded providers: ${settings.excludeProviders.join(", ")}`)
  }
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
        `quality ${fmt(route.quality)} ${shortQualitySource(route.qualitySource)}  ` +
        `reliability ${fmt(route.reliability)}  ${route.reason}` +
        (pinned ? " (pinned)" : ""),
    )
    if (route.chain?.length > 1) {
      io.log(`          chain ${formatChain(route.chain)}`)
    }
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
  const providerHeat = Object.entries(output.providerHealth).filter(
    ([, value]) => value.samples > 0 || value.state !== "unknown",
  )
  if (providerHeat.length) {
    io.log("\nProviders:")
    for (const [key, value] of providerHeat.sort()) {
      io.log(
        `  ${key.padEnd(20)} ${value.state.padEnd(9)} ` +
          `scope ${(settings.limitScopes?.[key] || "model").padEnd(8)} ` +
          `reliability ${fmt(value.reliability)}  samples ${value.samples}` +
          (value.cooldownUntil > Date.now()
            ? `  retry in ${Math.ceil((value.cooldownUntil - Date.now()) / 1000)}s`
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

async function scores(io, args, json) {
  const requested = valueFor(args, "--role")
  if (requested && !ROLES.includes(requested)) {
    io.error(`Usage: opencode-free scores [--role ${ROLES.join("|")}] [--json]`)
    return 2
  }
  const [settings, state, probes] = await Promise.all([
    loadSettings(),
    loadState(),
    loadProbes(),
  ])
  if (!state.catalog?.models?.length) {
    io.log("No catalog yet. Run `opencode-free init` or `opencode-free scan`.")
    return 0
  }
  const routing = chooseRoutes({
    catalog: state.catalog,
    state,
    probes,
    settings,
  })
  const roles = requested ? [requested] : ROLES
  const output = {
    profile: settings.profile,
    diversity: routing.diversity,
    limitScopes: settings.limitScopes,
    providerHealth: healthReport(state.providerHealth),
    updatedAt: probes.updatedAt,
    roles: {},
  }
  for (const role of roles) {
    const result = routing.roles[role]
    const chain = (result.chain || []).map((item) => item.key)
    const positions = new Map(chain.map((key, index) => [key, index + 1]))
    output.roles[role] = {
      primary: result.candidate
        ? {
            key: modelKey(result.candidate),
            reason: result.decision.reason,
            score: result.decision.score,
            independentBest: result.decision.independentBest,
            scoreLoss: result.decision.scoreLoss,
          }
        : undefined,
      chain,
      candidates: result.all.map((item) => ({
        ...item,
        selected: item.key === outputChainPrimary(result),
        chainPosition: positions.get(item.key),
        routingStatus: item.eligible
          ? positions.has(item.key)
            ? "chain"
            : "ranked"
          : item.excludedReason,
      })),
    }
  }
  if (json) {
    io.log(JSON.stringify(output, null, 2))
    return 0
  }

  io.log(
    `Cached routing inputs · profile ${settings.profile} · diversity ` +
      `${routing.diversity.enabled ? "on" : "off"}` +
      (routing.diversity.enabled
        ? ` (${routing.diversity.unit}, ${routing.diversity.providerCount} provider(s))`
        : routing.diversity.requested
          ? ` (${routing.diversity.providerCount} eligible provider${
              routing.diversity.providerCount === 1 ? "" : "s"
            })`
          : ""),
  )
  io.log(`Limit scopes: ${formatLimitScopes(settings.limitScopes)}`)
  if (routing.diversity.enabled) {
    io.log(
      `Overlap penalty ${fmt(routing.diversity.overlapPenalty)} · ` +
        `max primary loss ${fmt(routing.diversity.maxPrimaryScoreLoss)} · ` +
        `max quality loss ${fmt(routing.diversity.maxQualityLoss)}`,
    )
  }
  for (const role of roles) {
    const result = routing.roles[role]
    const report = output.roles[role]
    io.log(`\n${role.toUpperCase()}`)
    if (!result.candidate) {
      io.log(`  no eligible model · ${result.decision.reason}`)
      continue
    }
    io.log(
      `  primary ${modelKey(result.candidate)} · ${result.decision.reason} · ` +
        `utility ${fmt(result.decision.score)}`,
    )
    if (result.decision.reason === "role_diversity") {
      io.log(
        `  independent best ${result.decision.independentBest} · ` +
          `score loss ${fmt(result.decision.scoreLoss)}`,
      )
    }
    io.log(`  chain ${formatChain(report.chain)}`)
    io.log(
      `  ${"#".padEnd(3)}${"model".padEnd(48)}` +
        `${"utility".padStart(8)}${"quality".padStart(8)}${"prior".padStart(8)}` +
        `  ${"source".padEnd(8)}` +
        `${"reliab".padStart(7)}${"speed".padStart(7)}  ${"live".padStart(4)}  status`,
    )
    const position = new Map(report.chain.map((key, index) => [key, index + 1]))
    result.all.forEach((item, index) => {
      const chainPosition = position.get(item.key)
      const status = item.eligible
        ? chainPosition
          ? `chain ${chainPosition}`
          : "ranked"
        : item.excludedReason
      io.log(
        `  ${String(index + 1).padEnd(3)}${item.key.padEnd(48)}` +
          `${fmt(item.score).padStart(8)}${fmt(item.quality).padStart(8)}` +
          `${(item.priorKnown ? fmt(item.priorQuality) : "—").padStart(8)}` +
          `  ${shortQualitySource(item.qualitySource).padEnd(8)}` +
          `${fmt(item.reliability).padStart(7)}${fmt(item.speed).padStart(7)}  ` +
          `${String(item.liveSamples || 0).padStart(4)}  ${status}`,
      )
    })
  }
  const providers = Object.entries(output.providerHealth).filter(
    ([, value]) => value.samples > 0 || value.state !== "unknown",
  )
  if (providers.length) {
    io.log("\nProviders:")
    for (const [key, value] of providers.sort()) {
      io.log(
        `  ${key.padEnd(20)} ${value.state.padEnd(9)} ` +
          `scope ${(settings.limitScopes?.[key] || "model").padEnd(8)} ` +
          `samples ${value.samples}` +
          (value.cooldownUntil > Date.now()
            ? `  retry in ${Math.ceil((value.cooldownUntil - Date.now()) / 1000)}s`
            : ""),
      )
    }
  }
  if (!json) io.log("\nUse `opencode-free scores --json` for the complete routing inputs.")
  return 0
}

function outputChainPrimary(result) {
  return result.candidate ? modelKey(result.candidate) : undefined
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

async function priors(io, json) {
  const settings = await loadSettings()
  const overrideSettings = settings.qualityPriors || {}
  const families = {}
  for (const [familyID, family] of Object.entries(QUALITY_PRIORS.families)) {
    const model = parseKey(family.matches[0])
    if (!model) continue
    const prior = priorForModel(model, settings)
    families[familyID] = {
      sourceModel: family.sourceModel,
      matches: family.matches,
      evidence: family.evidence,
      publicQuality: publicQualitySummary(model, settings),
      scores: Object.fromEntries(
        ["reasoning", "coding", "codeGeneration", "toolUse", "instructionFollowing"].map((dimension) => [
          dimension,
          prior[dimension],
        ]),
      ),
      confidence: prior.confidence,
    }
  }
  const overrides = {}
  for (const [key, value] of Object.entries(overrideSettings)) {
    const parsed = parseKey(key)
    if (!parsed) continue
    overrides[key] = {
      ...priorForModel(parsed, settings),
      publicQuality: publicQualitySummary(parsed, settings),
      override: value,
    }
  }
  const output = {
    source: QUALITY_PRIORS.source,
    version: QUALITY_PRIORS.version,
    updatedAt: QUALITY_PRIORS.updatedAt,
    note: "Offline public-benchmark family estimates with exact endpoint matches. Unmapped models use the median mapped prior for their role.",
    families,
    overrides,
  }
  if (json) {
    io.log(JSON.stringify(output, null, 2))
    return 0
  }
  io.log(`Public quality priors · ${output.source} · updated ${output.updatedAt}`)
  io.log("Bundled family mappings are automatic; user overrides are optional.")
  io.log(
    "Scores normalize benchmarks against practical ranges, separate static code " +
      "generation from agentic coding, and keep missing dimensions neutral.",
  )
  for (const [familyID, value] of Object.entries(families).sort()) {
    io.log(
      `\n${familyID} · ${value.sourceModel} · confidence ${fmt(value.confidence)}` +
        ` · public ${ROLES.map((role) => fmt(value.publicQuality.roles[role])).join("/")}`,
    )
    io.log(`  matches ${value.matches.join(", ")}`)
    if (value.evidence.length) {
      io.log(
        `  evidence ${value.evidence
          .map((item) => `${item.benchmark} ${Number(item.score).toFixed(1)}${item.scale === 100 ? "%" : ""}`)
          .join(" · ")}`,
      )
    }
  }
  if (Object.keys(overrides).length) {
    io.log("\nUser overrides:")
    for (const [key, value] of Object.entries(overrides).sort()) {
      io.log(
        `  ${key.padEnd(48)} public ${ROLES.map((role) =>
          fmt(value.publicQuality.roles[role]),
        ).join("/")}`,
      )
    }
  }
  io.log("\nAdvanced overrides can be added in settings.json under qualityPriors.")
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

async function ignoreProvider(io, args, json) {
  const providerID = providerIDFrom(args)
  if (!providerID) {
    io.error("Usage: opencode-free ignore-provider <providerID>")
    return 2
  }
  const settings = await loadSettings()
  settings.excludeProviders = [...new Set([...settings.excludeProviders, providerID])]
  const saved = await saveSettings(settings)
  if (json) io.log(JSON.stringify({ excludeProviders: saved.excludeProviders }, null, 2))
  else io.log(`Excluded provider ${providerID}`)
  return 0
}

async function allowProvider(io, args, json) {
  const providerID = providerIDFrom(args)
  if (!providerID) {
    io.error("Usage: opencode-free allow-provider <providerID>")
    return 2
  }
  const settings = await loadSettings()
  settings.excludeProviders = settings.excludeProviders.filter((value) => value !== providerID)
  const saved = await saveSettings(settings)
  if (json) io.log(JSON.stringify({ excludeProviders: saved.excludeProviders }, null, 2))
  else io.log(`Provider ${providerID} is no longer excluded`)
  return 0
}

function providerIDFrom(args) {
  const [value] = args.filter((item) => !item.startsWith("--"))
  const providerID = value?.trim()
  if (!providerID || providerID === "*" || providerID.includes("/") || /\s/.test(providerID)) {
    return undefined
  }
  return providerID
}

async function config(io, json) {
  const [settings, state, probes] = await Promise.all([
    loadSettings(),
    loadState(),
    loadProbes(),
  ])
  const output = {
    paths: statePaths(),
    settings,
    catalogCount: state.catalog?.models?.length || 0,
    probeCount: Object.keys(probes.probes || {}).length,
  }
  if (json) io.log(JSON.stringify(output, null, 2))
  else {
    io.log(`Settings: ${statePaths().settings}`)
    io.log(`State:    ${statePaths().state}`)
    io.log(`Probes:   ${statePaths().probes}`)
    io.log(JSON.stringify(settings, null, 2))
  }
  return 0
}

function printModels(io, models, settings = {}) {
  io.log(
    `  ${"model".padEnd(46)}${"context".padStart(9)}  ${"input".padEnd(6)}  ` +
      `${"public P/B/V/F".padEnd(24)}variants`,
  )
  for (const model of models) {
    const vision = model.capabilities.input.some((type) => type.startsWith("image")) ? "vision" : "text"
    const variants = model.variants?.length ? model.variants.join(",") : "default"
    const quality = publicQualitySummary(model, settings)
    const scores = quality.known
      ? ROLES.map((role) => fmt(quality.roles[role])).join("/")
      : "— (neutral)"
    io.log(
      `  ${`${model.providerID}/${model.id}`.padEnd(46)}` +
        `${String(model.limit?.context || 0).padStart(9)}  ${vision.padEnd(6)}  ` +
        `${scores.padEnd(24)}${variants}`,
    )
  }
}

function modelSummary(model, settings = {}) {
  return {
    key: `${model.providerID}/${model.id}`,
    name: model.name,
    context: model.limit.context,
    vision: model.capabilities.input.some((type) => type.startsWith("image")),
    variants: model.variants,
    status: model.status,
    publicQuality: publicQualitySummary(model, settings),
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

function shortQualitySource(value) {
  if (value === "neutral") return "neutral"
  if (value === "user-config") return "override"
  if (value) return "public"
  return "neutral"
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

function formatChain(chain) {
  return (chain || []).join(" → ")
}

function healthReport(records = {}) {
  return Object.fromEntries(
    Object.entries(records || {}).map(([key, value]) => [
      key,
      {
        ...healthStats(value),
        state: effectiveState(value),
      },
    ]),
  )
}

function formatProviders(providers = [], excludeProviders = []) {
  const allowed = providers.includes("*") ? "all connected providers" : providers.join(", ")
  return excludeProviders.length ? `${allowed}, excluding ${excludeProviders.join(", ")}` : allowed
}

function formatLimitScopes(limitScopes = {}) {
  const entries = Object.entries(limitScopes).filter(
    ([, scope]) => scope === "provider" || scope === "model",
  )
  return entries.length
    ? entries.map(([provider, scope]) => `${provider}=${scope}`).join(" · ")
    : "all providers=model"
}
