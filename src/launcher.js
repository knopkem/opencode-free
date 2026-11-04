import { spawn } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access } from "node:fs/promises"
import { constants as osConstants } from "node:os"
import { delimiter, isAbsolute, join, resolve } from "node:path"
import {
  discoverFreeModels,
  probe as runProbes,
  selectAssignmentCandidates,
  selectDueProbeModels,
} from "./probe.js"
import { baseKey, modelKey } from "./catalog.js"
import { ROLES } from "./constants.js"
import { chooseRoutes } from "./router.js"
import {
  loadProbes,
  loadSettings,
  loadState,
  saveSettings,
  updateState,
} from "./state.js"

const REQUIRED_ROLES = ["plan", "build", "fast"]
const AGENT_ROLES = Object.freeze({
  plan: "plan",
  build: "build",
  general: "build",
  explore: "fast",
  title: "fast",
  summary: "fast",
  compaction: "fast",
})

export class LauncherError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = "LauncherError"
  }
}

export async function findExecutable(name = "opencode", env = process.env) {
  const candidates = []
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    candidates.push(resolve(name))
  } else {
    const extensions =
      process.platform === "win32"
        ? ["", ...String(env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
        : [""]
    for (const directory of String(env.PATH || "").split(delimiter)) {
      if (!directory) continue
      for (const extension of extensions) candidates.push(join(directory, `${name}${extension}`))
    }
  }
  for (const candidate of candidates) {
    try {
      await access(
        candidate,
        process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
      )
      return candidate
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new LauncherError(
    `OpenCode executable "${name}" was not found. Install OpenCode 2.x and make sure it is on PATH.`,
  )
}

export function parseInlineConfig(env = process.env) {
  const raw = env.OPENCODE_CONFIG_CONTENT
  if (raw === undefined || raw === "") return {}
  let config
  try {
    config = JSON.parse(raw)
  } catch (error) {
    throw new LauncherError(
      "OPENCODE_CONFIG_CONTENT must contain valid JSON.",
      { cause: error },
    )
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new LauncherError("OPENCODE_CONFIG_CONTENT must contain a JSON object.")
  }
  return config
}

export function addRouteModels(config, routes) {
  if (!routes?.build?.candidate) {
    throw new LauncherError("Cannot configure OpenCode without a build route.")
  }
  const next = { ...config }
  const build = routes.build.candidate
  const fast = routes.fast?.candidate || build
  next.model = modelKey(build)
  next.small_model = baseKey(fast)

  const existingAgents = config.agent
  if (
    existingAgents !== undefined &&
    (!existingAgents || typeof existingAgents !== "object" || Array.isArray(existingAgents))
  ) {
    throw new LauncherError("OPENCODE_CONFIG_CONTENT.agent must be a JSON object.")
  }
  const agents = { ...(existingAgents || {}) }
  for (const [agent, role] of Object.entries(AGENT_ROLES)) {
    const candidate = routes[role]?.candidate
    if (!candidate) continue
    const entry = {
      ...(agents[agent] && typeof agents[agent] === "object" ? agents[agent] : {}),
      model: baseKey(candidate),
    }
    if (candidate.variant) entry.variant = candidate.variant
    else delete entry.variant
    agents[agent] = entry
  }
  next.agent = agents
  return next
}

export function buildOpencodeConfig({
  existing = {},
  routes,
} = {}) {
  return addRouteModels(existing, routes)
}

export function withStandalone(args = []) {
  const separator = args.indexOf("--")
  const commandArgs = separator === -1 ? args : args.slice(0, separator)
  const selectsServer = commandArgs.some(
    (argument) =>
      argument === "--standalone" ||
      argument === "--server" ||
      argument.startsWith("--server="),
  )
  if (selectsServer) return [...args]
  if (separator === -1) return [...args, "--standalone"]
  return [...args.slice(0, separator), "--standalone", ...args.slice(separator)]
}

export function routeSummary(routes) {
  return ROLES.map((role) => {
    const candidate = routes[role]?.candidate
    return `${role}=${candidate ? modelKey(candidate) : "none"}`
  }).join(" ")
}

export function hasProbeData(probes) {
  return Boolean(Object.keys(probes?.probes || {}).length)
}

export async function prepareOpencodeLaunch({
  env = process.env,
  autoInit = true,
  discover = discoverFreeModels,
  probeModels = runProbes,
  onLog = () => {},
} = {}) {
  const executable = await findExecutable("opencode", env)
  let settings = await loadSettings(env)
  let state = await loadState(env)
  let initialized = false

  if (!state.catalog?.refreshedAt) {
    if (!autoInit) {
      throw new LauncherError(
        "No model catalog found. Run `opencode-free init` before launching OpenCode.",
      )
    }
    settings = await saveSettings(settings, env)
    let catalog
    try {
      catalog = await discover({ env, executable })
    } catch (error) {
      throw new LauncherError(`Could not initialize free models: ${error.message}`, {
        cause: error,
      })
    }
    if (state.catalog?.fingerprint !== catalog?.fingerprint) {
      await updateState((draft) => {
        draft.catalog = catalog
        return draft
      }, env)
    }
    state = await loadState(env)
    initialized = true
  }

  let probes = await loadProbes(env)
  if (settings.probe.onAssign) {
    const candidates = selectAssignmentCandidates(state.catalog, settings, state, { probes })
    const due = selectDueProbeModels({ models: candidates, settings, probes })
    if (due.length) {
      onLog(`Checking ${due.length} stale free-model candidate(s)...`)
      try {
        await probeModels({
          models: due.map((model) => baseKey(model)),
          timeoutMs: settings.probe.timeoutMs,
          concurrency: settings.probe.concurrency,
          refresh: true,
          onProgress: onLog,
          env,
          executable,
        })
      } catch (error) {
        onLog(`Availability probe failed; continuing with cached priors: ${error.message}`)
      }
      probes = await loadProbes(env)
      state = await loadState(env)
    }
  }
  const routing = chooseRoutes({
    catalog: state.catalog,
    state,
    probes,
    settings,
  })
  const routes = routing.roles
  const missing = REQUIRED_ROLES.filter((role) => !routes[role]?.candidate)
  if (missing.length) {
    throw new LauncherError(
      `No eligible free model for ${missing.join(", ")}. Run \`opencode-free status\` ` +
        "to inspect catalog, provider, and cooldown information.",
    )
  }

  const config = buildOpencodeConfig({
    existing: parseInlineConfig(env),
    routes,
  })
  return {
    executable,
    env: {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    },
    config,
    routes,
    initialized,
    hasProbes: hasProbeData(probes),
    catalogCount: state.catalog.models?.length || 0,
  }
}

export async function launchOpencode({
  args = [],
  env = process.env,
  cwd = process.cwd(),
  onLog = () => {},
  autoInit = true,
  discover = discoverFreeModels,
  spawnImpl = spawn,
} = {}) {
  const prepared = await prepareOpencodeLaunch({ env, autoInit, discover, onLog })
  if (prepared.initialized) {
    onLog(
      `Initialized ${prepared.catalogCount} free model(s); automatic routing is ready.`,
    )
  }
  if (!prepared.hasProbes) {
    onLog(
      "No availability probes yet; using public quality priors and live health. " +
        "Optional: run `opencode-free probe`.",
    )
  }
  onLog(`Starting OpenCode with ${routeSummary(prepared.routes)}`)

  const child = spawnImpl(prepared.executable, withStandalone(args), {
    cwd,
    env: prepared.env,
    stdio: "inherit",
  })
  return waitForChild(child)
}

export function waitForChild(child) {
  return new Promise((resolvePromise, reject) => {
    child.once("error", (error) => {
      reject(new LauncherError(`Could not start OpenCode: ${error.message}`, { cause: error }))
    })
    child.once("exit", (code, signal) => {
      resolvePromise(code ?? 128 + (osConstants.signals[signal] || 0))
    })
  })
}
