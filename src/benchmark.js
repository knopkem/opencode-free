import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { OpenCode } from "@opencode/client/promise"
import { BENCHMARK_METADATA_KEY, BENCHMARK_VERSION } from "./constants.js"
import {
  catalogFromModels,
  modelKey,
  selectVariant,
} from "./catalog.js"
import { BUILD_FIXTURE, PLANNING_FIXTURE } from "./fixtures.js"
import {
  loadBenchmarks,
  loadSettings,
  updateBenchmarks,
  updateState,
} from "./state.js"

export async function benchmark({
  quick = false,
  models = [],
  timeoutMs,
  concurrency,
  refresh = false,
  onProgress = () => {},
  env = process.env,
} = {}) {
  const settings = await loadSettings(env)
  const effectiveTimeout = clampInt(
    timeoutMs,
    10_000,
    15 * 60_000,
    quick ? settings.benchmark.quickTimeoutMs : settings.benchmark.fullTimeoutMs,
  )
  const effectiveConcurrency = clampInt(
    concurrency,
    1,
    8,
    quick ? settings.benchmark.quickConcurrency : settings.benchmark.fullConcurrency,
  )
  const work = await mkdtemp(join(tmpdir(), "opencode-free-bench-"))
  const password = randomBytes(24).toString("base64url")
  const port = await freePort()
  const server = await startServer({ work, port, password, env })
  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { Authorization: basic(password) },
  })

  const firstOutput = new Map()
  const eventAbort = new AbortController()
  const eventLoop = consumeTimingEvents(client, firstOutput, eventAbort.signal)

  try {
    const listed = await retry(
      async () => client.model.list({ types: ["chat"] }),
      80,
      250,
    )
    const catalog = catalogFromModels(listed.data, settings)
    await updateState((state) => {
      state.catalog = catalog
      return state
    }, env)
    if (!catalog.models.length) {
      throw new Error(
        `No free chat models found for providers: ${settings.providers.join(", ")}`,
      )
    }

    const selected = selectBenchmarkModels(catalog, settings, models, quick)
    if (!selected.length) throw new Error("No matching benchmark models")
    const cached = await loadBenchmarks(env)
    const due = selectDueModels({
      models: selected,
      settings,
      benchmarks: cached,
      catalog,
      refresh: refresh || models.length > 0,
    })
    await updateBenchmarks((data) => {
      data.catalogFingerprint = catalog.fingerprint
      return data
    }, env)
    if (!due.length) {
      onProgress(
        `All ${selected.length} model(s) have fresh benchmark results; use --refresh to rerun`,
      )
      return {
        quick,
        models: selected.map((model) => `${model.providerID}/${model.id}`),
        benchmarked: [],
        reused: selected.length,
        runs: [],
        summaries: cached.summaries,
        concurrency: effectiveConcurrency,
        timeoutMs: effectiveTimeout,
      }
    }

    onProgress(
      `Benchmarking ${due.length} of ${selected.length} model(s) in ${quick ? "quick" : "full"} mode ` +
        `(concurrency ${effectiveConcurrency}, ${Math.round(effectiveTimeout / 1000)}s per case)`,
    )

    const runs = []
    const repetitions = quick ? 1 : settings.benchmark.fullRepetitions
    let started = 0
    let finished = 0
    await runPool(due, effectiveConcurrency, async (model) => {
      started += 1
      const label = `${model.providerID}/${model.id}`
      onProgress(`[${started}/${due.length}] start ${label}`)
      const planVariant = selectVariant(model, "plan", settings.profile)
      const buildVariant = selectVariant(model, "build", settings.profile)
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const suffix = repetitions > 1 ? ` round ${repetition}/${repetitions}` : ""
        const plan = await runPlanningCase({
          client,
          work,
          model,
          variant: planVariant,
          timeoutMs: effectiveTimeout,
          firstOutput,
          onProgress,
        })
        runs.push(plan)
        await mergeRunIntoSummary(
          plan,
          { fingerprint: catalog.fingerprint, settings, contended: effectiveConcurrency > 1 },
          env,
        )
        onProgress(
          `  ${label} plan${suffix}: ${
            plan.error
              ? `error (${plan.error.message})`
              : `quality=${plan.quality.toFixed(2)} ${Math.round(plan.durationMs || 0)}ms`
          }`,
        )

        const build = await runBuildCase({
          client,
          work,
          model,
          variant: buildVariant,
          timeoutMs: effectiveTimeout,
          firstOutput,
          onProgress,
        })
        runs.push(build)
        await mergeRunIntoSummary(
          build,
          { fingerprint: catalog.fingerprint, settings, contended: effectiveConcurrency > 1 },
          env,
        )
        onProgress(
          `  ${label} build${suffix}: ${
            build.error
              ? `error (${build.error.message})`
              : `quality=${build.quality.toFixed(2)} ${Math.round(build.durationMs || 0)}ms`
          }`,
        )
      }
      finished += 1
      onProgress(`[${finished}/${due.length}] done ${label}`)
    })

    const final = await loadBenchmarks(env)
    return {
      quick,
      models: selected.map((model) => `${model.providerID}/${model.id}`),
      benchmarked: due.map((model) => `${model.providerID}/${model.id}`),
      reused: selected.length - due.length,
      runs,
      summaries: final.summaries,
      concurrency: effectiveConcurrency,
      timeoutMs: effectiveTimeout,
    }
  } finally {
    eventAbort.abort()
    await eventLoop.catch(() => {})
    await server.stop()
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

export async function discoverFreeModels({ env = process.env } = {}) {
  const settings = await loadSettings(env)
  const work = await mkdtemp(join(tmpdir(), "opencode-free-scan-"))
  const password = randomBytes(18).toString("base64url")
  const port = await freePort()
  const server = await startServer({ work, port, password, env })
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

export function selectBenchmarkModels(catalog, settings, requested = [], quick = false) {
  let models = catalog.models
  if (requested.length) {
    const wanted = new Set(requested.map((value) => String(value).replace(/#.*$/, "")))
    models = models.filter((model) => wanted.has(`${model.providerID}/${model.id}`))
  }
  if (quick && models.length > 10) models = models.slice(0, 10)
  return models
}

export function selectDueModels({
  models,
  settings,
  benchmarks,
  catalog,
  refresh = false,
  now = Date.now(),
}) {
  if (refresh) return models
  if (benchmarks.catalogFingerprint !== catalog.fingerprint) return models
  const ttl = Number(settings.benchmark.cacheTtlMs)
  return models.filter((model) => {
    for (const role of ["plan", "build"]) {
      const chosenKey = modelKey({
        ...model,
        variant: selectVariant(model, role, settings.profile),
      })
      const summary = benchmarks.summaries?.[role]?.[chosenKey]
      if (!summary?.updatedAt) return true
      if (summary.measurementVersion !== BENCHMARK_VERSION) return true
      const updated = Date.parse(summary.updatedAt)
      if (!Number.isFinite(updated)) return true
      if (Number.isFinite(ttl) && ttl > 0 && now - updated > ttl) return true
    }
    return false
  })
}

async function runPool(items, concurrency, worker) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await worker(items[index], index)
    }
  })
  await Promise.all(workers)
}

async function runPlanningCase({ client, work, model, variant, timeoutMs, firstOutput }) {
  const fixture = await materializeFixture(work, PLANNING_FIXTURE, "plan")
  return runAgentCase({
    client,
    model,
    variant,
    fixture,
    role: "plan",
    prompt: PLANNING_FIXTURE.prompt,
    timeoutMs,
    firstOutput,
    async score({ text }) {
      const before = PLANNING_FIXTURE.files["src/cart.js"]
      const after = await readFile(join(fixture.directory, "src/cart.js"), "utf8").catch(() => "")
      const unchanged = after === before
      return {
        quality: PLANNING_FIXTURE.score(text) * (unchanged ? 1 : 0.5),
        capability: text.trim().length > 0 ? 1 : 0,
        details: { unchanged, validAnswer: PLANNING_FIXTURE.score(text) > 0 },
      }
    },
  })
}

async function runBuildCase({ client, work, model, variant, timeoutMs, firstOutput }) {
  const fixture = await materializeFixture(work, BUILD_FIXTURE, "build")
  return runAgentCase({
    client,
    model,
    variant,
    fixture,
    role: "build",
    prompt: BUILD_FIXTURE.prompt,
    timeoutMs,
    firstOutput,
    async score() {
      await writeFile(
        join(fixture.directory, "test/math.test.js"),
        BUILD_FIXTURE.files["test/math.test.js"],
        "utf8",
      )
      const visiblePass = (await runTests(fixture.directory)).ok
      await writeFile(
        join(fixture.directory, "test/hidden.test.js"),
        BUILD_FIXTURE.hiddenFile["test/hidden.test.js"],
        "utf8",
      )
      const all = await runTests(fixture.directory)
      const hiddenPass = all.ok
      return {
        quality: BUILD_FIXTURE.score({ visiblePass, hiddenPass }),
        capability: hiddenPass || visiblePass ? 1 : 0,
        details: { visiblePass, hiddenPass, exitCode: all.code },
      }
    },
  })
}

async function runAgentCase({
  client,
  model,
  variant,
  fixture,
  role,
  prompt,
  timeoutMs,
  firstOutput,
  score,
}) {
  const startedAt = Date.now()
  let session
  try {
    session = await client.session.create({
      title: `opencode-free ${role}: ${model.id}`,
      agent: "build",
      model: {
        providerID: model.providerID,
        id: model.id,
        ...(variant ? { variant } : {}),
      },
      location: { directory: fixture.directory },
      metadata: { [BENCHMARK_METADATA_KEY]: true },
    })
    firstOutput.delete(session.id)
    await client.session.prompt({
      sessionID: session.id,
      text: prompt,
      metadata: { [BENCHMARK_METADATA_KEY]: true },
    })
    await withTimeout(
      client.experimental.session.wait({ sessionID: session.id }),
      timeoutMs,
      `Model ${model.providerID}/${model.id} timed out after ${timeoutMs}ms`,
    )
    const completedAt = Date.now()
    const messages = await client.message.list({ sessionID: session.id })
    const assistants = (messages.data || []).filter((message) => message.type === "assistant")
    const lastError = assistants.at(-1)?.error
    if (lastError) {
      const error = new Error(lastError.message || `Provider returned ${lastError.type}`)
      error.type = lastError.type
      error.status = lastError.status
      error.retryAfterMs = lastError.retryAfterMs
      throw error
    }
    const text = assistants
      .flatMap((message) =>
        (message.content || []).filter((part) => part.type === "text").map((part) => part.text),
      )
      .join("\n")
    const tokens = assistants.reduce(
      (total, message) => {
        total.output += Number(message.tokens?.output || 0)
        total.reasoning += Number(message.tokens?.reasoning || 0)
        return total
      },
      { output: 0, reasoning: 0 },
    )
    const scored = await score({ text, messages: messages.data || [] })
    const first = firstOutput.get(session.id)
    const durationMs = completedAt - startedAt
    const generationStart = first || startedAt
    const generationMs = Math.max(1, completedAt - generationStart)
    return {
      key: modelKey({ ...model, variant }),
      role,
      model: `${model.providerID}/${model.id}`,
      variant,
      at: new Date(startedAt).toISOString(),
      durationMs,
      ttftMs: first ? first - startedAt : undefined,
      tps: tokens.output + tokens.reasoning > 0 ? ((tokens.output + tokens.reasoning) / generationMs) * 1000 : undefined,
      outputTokens: tokens.output,
      reasoningTokens: tokens.reasoning,
      quality: clamp(scored.quality),
      capability: clamp(scored.capability),
      details: scored.details,
      text: String(text).slice(0, 12_000),
      error: undefined,
      timeoutMs,
      tooSlow: durationMs >= timeoutMs,
    }
  } catch (error) {
    if (session?.id) await client.session.interrupt({ sessionID: session.id }).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    return {
      key: modelKey({ ...model, variant }),
      role,
      model: `${model.providerID}/${model.id}`,
      variant,
      at: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      quality: undefined,
      capability: undefined,
      error: {
        message,
        type: error?.type || error?.name,
      },
      text: "",
      timeoutMs,
      tooSlow: /timed out after/i.test(message),
    }
  } finally {
    if (session?.id) await client.session.remove({ sessionID: session.id }).catch(() => {})
  }
}

async function materializeFixture(work, fixture, prefix) {
  const directory = await mkdtemp(join(work, `${prefix}-`))
  for (const [name, content] of Object.entries(fixture.files)) {
    const target = resolve(directory, name)
    await mkdir(join(target, ".."), { recursive: true })
    await writeFile(target, content, "utf8")
  }
  return { directory }
}

async function runTests(directory, timeoutMs = 15_000) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--test"], {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1" },
    })
    let output = ""
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish({ ok: false, code: -1, timedOut: true, output: output.slice(-20_000) })
    }, timeoutMs)
    timer.unref?.()
    child.stdout.on("data", (chunk) => {
      output += chunk
    })
    child.stderr.on("data", (chunk) => {
      output += chunk
    })
    child.on("error", (error) => finish({ ok: false, code: -1, output: String(error) }))
    child.on("exit", (code) => finish({ ok: code === 0, code, output: output.slice(-20_000) }))
  })
}

async function mergeRunIntoSummary(run, { fingerprint, settings, contended }, env) {
  await updateBenchmarks((data) => {
    const role = run.role
    data.catalogFingerprint = fingerprint
    data.summaries[role] ||= {}
    const existing = data.summaries[role][run.key] || {
      samples: 0,
      successes: 0,
      failures: 0,
      qualityTotal: 0,
      qualitySamples: 0,
      capabilityTotal: 0,
      capabilitySamples: 0,
      durationTotal: 0,
      durationSamples: 0,
      ttftTotal: 0,
      ttftSamples: 0,
      tpsTotal: 0,
      tpsSamples: 0,
    }
    const next = { ...existing }
    next.samples += 1
    if (run.error) {
      next.failures += 1
    } else {
      next.successes += 1
      if (Number.isFinite(run.quality)) {
        next.qualityTotal += run.quality
        next.qualitySamples += 1
      }
      if (Number.isFinite(run.capability)) {
        next.capabilityTotal += run.capability
        next.capabilitySamples += 1
      }
      if (Number.isFinite(run.durationMs)) {
        next.durationTotal += run.durationMs
        next.durationSamples += 1
      }
      if (Number.isFinite(run.ttftMs)) {
        next.ttftTotal += run.ttftMs
        next.ttftSamples += 1
      }
      if (Number.isFinite(run.tps)) {
        next.tpsTotal += run.tps
        next.tpsSamples += 1
      }
    }
    const tooSlow = Boolean(run.tooSlow)
    const lowQuality = !run.error && Number(run.quality) <= settings.benchmark.minQuality
    data.summaries[role][run.key] = {
      ...next,
      key: run.key,
      role,
      model: run.model,
      variant: run.variant,
      quality: next.qualitySamples ? next.qualityTotal / next.qualitySamples : undefined,
      capability: next.capabilitySamples ? next.capabilityTotal / next.capabilitySamples : undefined,
      reliability: next.successes / Math.max(1, next.samples),
      durationMs: next.durationSamples ? next.durationTotal / next.durationSamples : undefined,
      ttftMs: next.ttftSamples ? next.ttftTotal / next.ttftSamples : undefined,
      tps: next.tpsSamples ? next.tpsTotal / next.tpsSamples : undefined,
      updatedAt: new Date().toISOString(),
      lastError: run.error,
      measurementVersion: BENCHMARK_VERSION,
      disqualified: tooSlow || lowQuality,
      disqualifyReason: tooSlow
        ? `exceeded ${Math.round((run.timeoutMs || 0) / 1000)}s case cap`
        : lowQuality
          ? `quality ${Number(run.quality).toFixed(2)} below ${settings.benchmark.minQuality}`
          : undefined,
      contended,
    }
    data.runs = [...(data.runs || []), run].slice(-250)
    return data
  }, env)
}

async function consumeTimingEvents(client, firstOutput, signal) {
  try {
    for await (const event of client.event.subscribe({
      signal,
      types: ["session.text.started", "session.reasoning.started", "session.tool.input.started"],
    })) {
      const sessionID = event.data?.sessionID
      if (sessionID && !firstOutput.has(sessionID)) firstOutput.set(sessionID, event.created || Date.now())
    }
  } catch (error) {
    if (!signal.aborted && error?.name !== "AbortError") {
      // Timing is optional; benchmark results remain valid without TTFT.
      console.error("opencode-free: benchmark timing stream failed:", error.message || error)
    }
  }
}

async function startServer({ work, port, password, env }) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    snapshot: false,
    instructions: [],
    plugin: [],
    permission: { "*": "allow" },
  }
  const child = spawn(
    "opencode",
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

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0))
}

function clampInt(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}
