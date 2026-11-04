import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { DEFAULT_SETTINGS, STATE_VERSION } from "./constants.js"

const LOCK_STALE_MS = 30_000
const LOCK_TIMEOUT_MS = 5_000

export function dataHome(env = process.env) {
  const root = env.OPENCODE_FREE_HOME || env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return env.OPENCODE_FREE_HOME ? root : join(root, "opencode-free")
}

export function statePaths(env = process.env) {
  const home = dataHome(env)
  return {
    home,
    settings: join(home, "settings.json"),
    state: join(home, "state.json"),
    benchmarks: join(home, "benchmarks.json"),
    lock: join(home, "state.lock"),
  }
}

export function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    catalog: {
      refreshedAt: null,
      fingerprint: null,
      models: [],
    },
    health: {},
    routingCounts: {},
    decisions: [],
    lastRoute: null,
  }
}

export function emptyBenchmarks() {
  return {
    version: 1,
    updatedAt: null,
    summaries: {},
    runs: [],
  }
}

export function mergeSettings(input = {}, base = DEFAULT_SETTINGS) {
  const merged = {
    ...base,
    ...input,
    providers: Array.isArray(input.providers) ? input.providers.map(String) : [...base.providers],
    excludeModels: Array.isArray(input.excludeModels)
      ? input.excludeModels.map(String)
      : [...base.excludeModels],
    pinnedModels: {
      ...base.pinnedModels,
      ...(input.pinnedModels && typeof input.pinnedModels === "object" ? input.pinnedModels : {}),
    },
    speed: { ...base.speed, ...(input.speed && typeof input.speed === "object" ? input.speed : {}) },
    slow: { ...base.slow, ...(input.slow && typeof input.slow === "object" ? input.slow : {}) },
    benchmark: {
      ...base.benchmark,
      ...(input.benchmark && typeof input.benchmark === "object" ? input.benchmark : {}),
    },
  }
  if (!["quality", "balanced", "fast"].includes(merged.profile)) merged.profile = "balanced"
  merged.maxFailovers = clampInt(merged.maxFailovers, 0, 10, base.maxFailovers)
  merged.rateLimitCooldownMs = clampInt(
    merged.rateLimitCooldownMs,
    1_000,
    24 * 60 * 60_000,
    base.rateLimitCooldownMs,
  )
  merged.quotaCooldownMs = clampInt(merged.quotaCooldownMs, 1_000, 24 * 60 * 60_000, base.quotaCooldownMs)
  merged.serverCooldownMs = clampInt(merged.serverCooldownMs, 1_000, 24 * 60 * 60_000, base.serverCooldownMs)
  merged.unknownCooldownMs = clampInt(merged.unknownCooldownMs, 1_000, 24 * 60 * 60_000, base.unknownCooldownMs)
  merged.benchmark.quickTimeoutMs = clampInt(
    merged.benchmark.quickTimeoutMs,
    10_000,
    15 * 60_000,
    base.benchmark.quickTimeoutMs,
  )
  merged.benchmark.fullTimeoutMs = clampInt(
    merged.benchmark.fullTimeoutMs,
    10_000,
    15 * 60_000,
    base.benchmark.fullTimeoutMs,
  )
  merged.benchmark.quickConcurrency = clampInt(
    merged.benchmark.quickConcurrency,
    1,
    8,
    base.benchmark.quickConcurrency,
  )
  merged.benchmark.fullConcurrency = clampInt(
    merged.benchmark.fullConcurrency,
    1,
    8,
    base.benchmark.fullConcurrency,
  )
  merged.benchmark.fullRepetitions = clampInt(
    merged.benchmark.fullRepetitions,
    1,
    5,
    base.benchmark.fullRepetitions,
  )
  merged.benchmark.cacheTtlMs = clampInt(
    merged.benchmark.cacheTtlMs,
    0,
    30 * 24 * 60 * 60_000,
    base.benchmark.cacheTtlMs,
  )
  merged.benchmark.minQuality = Math.max(
    0,
    Math.min(1, Number(merged.benchmark.minQuality) || base.benchmark.minQuality),
  )
  return merged
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return fallback
    if (error instanceof SyntaxError) return fallback
    throw error
  }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temporary, path)
}

export async function loadSettings(env = process.env) {
  const paths = statePaths(env)
  return mergeSettings((await readJson(paths.settings, {})) || {})
}

export async function saveSettings(settings, env = process.env) {
  const paths = statePaths(env)
  const normalized = mergeSettings(settings)
  await writeJson(paths.settings, normalized)
  return normalized
}

export async function loadState(env = process.env) {
  const paths = statePaths(env)
  const state = await readJson(paths.state, emptyState())
  return {
    ...emptyState(),
    ...state,
    catalog: { ...emptyState().catalog, ...(state.catalog || {}) },
    health: state.health || {},
    routingCounts: state.routingCounts || {},
    decisions: Array.isArray(state.decisions) ? state.decisions : [],
  }
}

export async function saveState(state, env = process.env) {
  const paths = statePaths(env)
  const next = { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() }
  await writeJson(paths.state, next)
  return next
}

export async function updateState(mutator, env = process.env) {
  return withLock(
    async () => {
      const state = await loadState(env)
      const next = (await mutator(state)) || state
      return saveState(next, env)
    },
    env,
    statePaths(env).lock,
  )
}

export async function loadBenchmarks(env = process.env) {
  const paths = statePaths(env)
  const data = await readJson(paths.benchmarks, emptyBenchmarks())
  return {
    ...emptyBenchmarks(),
    ...data,
    summaries: data.summaries || {},
    runs: Array.isArray(data.runs) ? data.runs : [],
  }
}

export async function saveBenchmarks(data, env = process.env) {
  const paths = statePaths(env)
  const next = { ...data, version: 1, updatedAt: new Date().toISOString() }
  await writeJson(paths.benchmarks, next)
  return next
}

export async function updateBenchmarks(mutator, env = process.env) {
  return withLock(
    async () => {
      const data = await loadBenchmarks(env)
      const next = (await mutator(data)) || data
      return saveBenchmarks(next, env)
    },
    env,
    statePaths(env).lock,
  )
}

export async function withLock(fn, env = process.env, lockPath = statePaths(env).lock) {
  await mkdir(dirname(lockPath), { recursive: true })
  const started = Date.now()
  let handle
  while (!handle) {
    try {
      handle = await open(lockPath, "wx")
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`)
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await rm(lockPath, { force: true })
          continue
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for opencode-free state lock at ${lockPath}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  try {
    return await fn()
  } finally {
    await handle.close().catch(() => {})
    await rm(lockPath, { force: true }).catch(() => {})
  }
}

export function appendDecision(state, decision, limit = 100) {
  state.decisions = [...(state.decisions || []), decision].slice(-limit)
  state.lastRoute = decision
  return state
}
