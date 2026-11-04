import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { OpenCode } from "@opencode/client/promise"
import { PROBE_VERSION } from "./constants.js"
import { probeStateFor } from "./availability.js"
import {
  baseKey,
  catalogFromModels,
  modelKey,
  selectVariant,
} from "./catalog.js"
import { classifyError, isEligibleHealth, limitScopeFor, recordFailure } from "./health.js"
import { priorForModel } from "./quality.js"
import { chooseRoutes } from "./router.js"
import {
  emptyState,
  loadProbes,
  loadSettings,
  loadState,
  updateProbes,
  updateState,
} from "./state.js"

export async function probe({
  models = [],
  all = false,
  timeoutMs,
  concurrency,
  refresh = false,
  onProgress = () => {},
  env = process.env,
  executable = "opencode",
} = {}) {
  const settings = await loadSettings(env)
  const effectiveTimeout = clampInt(
    timeoutMs,
    10_000,
    15 * 60_000,
    settings.probe.timeoutMs,
  )
  const effectiveConcurrency = clampInt(
    concurrency,
    1,
    8,
    settings.probe.concurrency,
  )
  const work = await mkdtemp(join(tmpdir(), "opencode-free-probe-"))
  const password = randomBytes(24).toString("base64url")
  const port = await freePort()
  const server = await startServer({ work, port, password, env, executable })
  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { Authorization: basic(password) },
  })

  try {
    const listed = await retry(
      async () => client.model.list({ types: ["chat"] }),
      80,
      250,
    )
    const catalog = catalogFromModels(listed.data, settings)
    const state = await updateState((draft) => {
      draft.catalog = catalog
      return draft
    }, env)
    if (!catalog.models.length) {
      throw new Error(
        `No free chat models found for providers: ${
          settings.providers.includes("*") ? "all connected providers" : settings.providers.join(", ")
        }${settings.excludeProviders.length ? ` (excluding ${settings.excludeProviders.join(", ")})` : ""}`,
      )
    }

    const current = await loadProbes(env)
    const selected = selectProbeModels(catalog, settings, models, {
      state,
      probes: current,
      all,
    })
    if (!selected.length) {
      if (models.length) throw new Error("No matching probe models")
      return {
        models: [],
        probed: [],
        reused: 0,
        skipped: [],
        probes: [],
        ok: 0,
        failed: 0,
        concurrency: effectiveConcurrency,
        timeoutMs: effectiveTimeout,
      }
    }
    const due = selectDueProbeModels({
      models: selected,
      settings,
      probes: current,
      refresh: refresh || models.length > 0,
    })
    const runnable = due.filter(
      (model) => isEligibleHealth(state.providerHealth?.[model.providerID]),
    )
    const cooling = due.filter(
      (model) => !isEligibleHealth(state.providerHealth?.[model.providerID]),
    )
    const skipped = cooling.map((model) => ({
      model: `${model.providerID}/${model.id}`,
      reason: `provider ${model.providerID} cooldown`,
    }))

    await updateProbes((data) => {
      data.catalogFingerprint = catalog.fingerprint
      return data
    }, env)

    if (!runnable.length) {
      onProgress(
        cooling.length
          ? `All ${cooling.length} due model(s) are in an active provider cooldown; no requests sent`
          : `All ${selected.length} model(s) have a fresh probe; use --refresh to rerun`,
      )
      return {
        models: selected.map((model) => `${model.providerID}/${model.id}`),
        probed: [],
        reused: selected.length - cooling.length,
        skipped,
        probes: [],
        ok: 0,
        failed: 0,
        concurrency: effectiveConcurrency,
        timeoutMs: effectiveTimeout,
      }
    }

    onProgress(
      `Probing ${runnable.length} of ${selected.length} model(s) with one no-tool request ` +
        `(concurrency ${effectiveConcurrency}, ${Math.round(effectiveTimeout / 1000)}s cap)`,
    )
    const probes = []
    const blockedProviders = new Set()
    let started = 0
    let finished = 0
    await runPool(runnable, effectiveConcurrency, async (model) => {
      started += 1
      const label = `${model.providerID}/${model.id}`
      if (blockedProviders.has(model.providerID)) {
        skipped.push({ model: label, reason: `provider ${model.providerID} quota` })
        onProgress(`[${started}/${runnable.length}] skip ${label} (provider quota)`)
        return
      }
      onProgress(`[${started}/${runnable.length}] probe ${label}`)
      const variant = selectVariant(model, "build", settings.profile)
      const result = await runProbeCase({
        client,
        model,
        variant,
        timeoutMs: effectiveTimeout,
      })
      probes.push(result)
      if (result.error) {
        const blocked = providerLimitFromRun(result, settings)
        if (blocked) {
          blockedProviders.add(blocked)
          await persistProviderLimit(result, settings, env)
        }
      }
      await mergeProbe(result, { fingerprint: catalog.fingerprint }, env)
      onProgress(
        `  ${label} probe: ${
          result.error
            ? `error (${result.error.message})`
            : `${result.responseOk ? "ok" : "unexpected response"} ${Math.round(result.durationMs || 0)}ms`
        }`,
      )
      finished += 1
      onProgress(`[${finished}/${runnable.length}] done ${label}`)
    })

    return {
      models: selected.map((model) => `${model.providerID}/${model.id}`),
      probed: probes.filter((item) => !item.error).map((item) => item.model),
      reused: selected.length - due.length - cooling.length,
      skipped,
      probes,
      ok: probes.filter((item) => !item.error && item.responseOk).length,
      failed: probes.filter((item) => item.error || !item.responseOk).length,
      concurrency: effectiveConcurrency,
      timeoutMs: effectiveTimeout,
    }
  } finally {
    await server.stop()
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

export function selectProbeModels(
  catalog,
  settings,
  requested = [],
  { state, probes, all = false } = {},
) {
  if (requested.length) {
    const wanted = new Set(requested.map((value) => String(value).replace(/#.*$/, "")))
    return catalog.models.filter((model) => wanted.has(`${model.providerID}/${model.id}`))
  }
  if (all) return [...catalog.models]
  return selectAssignmentCandidates(catalog, settings, state || emptyState(), {
    probes,
    perRole: settings.probe.candidatesPerRole,
  })
}

export function selectAssignmentCandidates(
  catalog,
  settings,
  state,
  { probes, perRole = 4 } = {},
) {
  const routing = chooseRoutes({ catalog, state, probes, settings })
  const ordered = []
  const seen = new Set()
  const push = (model) => {
    if (!model) return
    const key = baseKey(model)
    if (seen.has(key)) return
    seen.add(key)
    ordered.push(model)
  }
  for (const role of ["plan", "build"]) {
    const evaluation = routing.evaluations[role]
    const ranked = evaluation?.ranked || []
    for (const item of ranked.slice(0, perRole)) {
      push(evaluation.choiceByKey.get(item.key))
    }
    const unknown = ranked.find((item) => !item.priorKnown)
    if (unknown) push(evaluation.choiceByKey.get(unknown.key))
  }
  if (ordered.length) return ordered
  return [...catalog.models]
    .sort((left, right) => {
      const leftPrior = priorForModel(left, settings)
      const rightPrior = priorForModel(right, settings)
      return rightPrior.score - leftPrior.score
    })
    .slice(0, perRole)
}

export function selectDueProbeModels({
  models,
  settings,
  probes,
  refresh = false,
  now = Date.now(),
}) {
  if (refresh) return models
  return models.filter((model) => {
    const cached = probes.probes?.[baseKey(model)]
    if (cached?.measurementVersion !== PROBE_VERSION) return true
    return !probeStateFor(cached, settings, now).fresh
  })
}

async function runProbeCase({ client, model, variant, timeoutMs }) {
  const startedAt = Date.now()
  try {
    const response = await withTimeout(
      client.experimental.generate.text({
        prompt: "Reply with exactly: ok",
        model: {
          providerID: model.providerID,
          id: model.id,
          ...(variant ? { variant } : {}),
        },
      }),
      timeoutMs,
      `Model ${model.providerID}/${model.id} timed out after ${timeoutMs}ms`,
    )
    const completedAt = Date.now()
    const text = String(response?.text || "").slice(0, 2_000)
    return {
      key: modelKey({ ...model, variant }),
      providerID: model.providerID,
      model: `${model.providerID}/${model.id}`,
      variant,
      at: new Date(startedAt).toISOString(),
      durationMs: completedAt - startedAt,
      turns: 1,
      text,
      responseOk: text.trim().toLowerCase() === "ok",
      error: undefined,
      timeoutMs,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      key: modelKey({ ...model, variant }),
      providerID: model.providerID,
      model: `${model.providerID}/${model.id}`,
      variant,
      at: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      turns: 0,
      text: "",
      responseOk: false,
      error: {
        message,
        type: error?.type || error?.name,
        status: error?.status,
      },
      timeoutMs,
    }
  }
}

export function providerLimitFromRun(run, settings) {
  if (!run?.error) return undefined
  const kind = classifyError(run.error)
  if (kind !== "rate_limit" && kind !== "quota") return undefined
  return limitScopeFor(run.key, kind, settings) === "provider"
    ? run.key.split("/")[0]
    : undefined
}

async function persistProviderLimit(run, settings, env) {
  await updateState((state) => {
    recordFailure(state, run.key, run.error, settings)
    return state
  }, env)
}

async function mergeProbe(run, { fingerprint }, env) {
  await updateProbes((data) => {
    data.catalogFingerprint = fingerprint
    data.probes ||= {}
    data.probes[run.key.replace(/#.*$/, "")] = {
      key: run.key.replace(/#.*$/, ""),
      model: run.model,
      variant: run.variant,
      at: run.at,
      durationMs: run.durationMs,
      turns: run.turns,
      responseOk: run.responseOk,
      error: run.error
        ? {
            type: run.error.type,
            status: run.error.status,
            message: String(run.error.message || "").slice(0, 500),
          }
        : undefined,
      measurementVersion: PROBE_VERSION,
    }
    return data
  }, env)
}

export async function discoverFreeModels({ env = process.env, executable = "opencode" } = {}) {
  const settings = await loadSettings(env)
  const work = await mkdtemp(join(tmpdir(), "opencode-free-scan-"))
  const password = randomBytes(18).toString("base64url")
  const port = await freePort()
  const server = await startServer({ work, port, password, env, executable })
  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { Authorization: basic(password) },
  })
  try {
    const listed = await retry(async () => client.model.list({ types: ["chat"] }), 80, 250)
    const catalog = catalogFromModels(listed.data, settings)
    await updateState((state) => {
      state.catalog = catalog
      return state
    }, env)
    return catalog
  } finally {
    await server.stop()
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

async function runPool(items, concurrency, worker) {
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= items.length) return
        await worker(items[index], index)
      }
    },
  )
  await Promise.all(workers)
}

async function startServer({ work, port, password, env, executable = "opencode" }) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    snapshot: false,
    instructions: [],
    plugin: [],
    permission: { "*": "allow" },
  }
  const child = spawn(
    executable,
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: work,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        NO_COLOR: "1",
      },
    },
  )
  let log = ""
  child.stdout.on("data", (chunk) => {
    log = (log + chunk).slice(-20_000)
  })
  child.stderr.on("data", (chunk) => {
    log = (log + chunk).slice(-20_000)
  })
  let exited
  const exitPromise = new Promise((resolvePromise) => {
    exited = resolvePromise
  })
  child.on("exit", (code, signal) => exited({ code, signal }))
  const started = Date.now()
  while (Date.now() - started < 30_000) {
    if (child.exitCode !== null) {
      throw new Error(`opencode serve exited early (${child.exitCode}):\n${log}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/model?types=chat`, {
        headers: { Authorization: basic(password) },
      })
      if (response.ok) {
        return {
          child,
          async stop() {
            if (child.exitCode === null) child.kill("SIGTERM")
            await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 3_000))])
            if (child.exitCode === null) child.kill("SIGKILL")
          },
        }
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
  }
  child.kill("SIGKILL")
  throw new Error(`Timed out starting opencode serve:\n${log}`)
}

async function retry(fn, attempts, delay) {
  let last
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await fn()
    } catch (error) {
      last = error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delay))
    }
  }
  throw last
}

async function withTimeout(promise, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolvePromise(address.port))
    })
  })
}

function basic(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}
