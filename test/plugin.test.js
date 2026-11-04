import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCodeFreePlugin } from "../src/plugin.js"
import { catalogFromModels, modelKey } from "../src/catalog.js"
import { loadState, mergeSettings, saveBenchmarks, saveSettings, saveState, emptyBenchmarks } from "../src/state.js"

const models = [
  {
    providerID: "opencode",
    id: "alpha-free",
    name: "Alpha Free",
    type: "chat",
    enabled: true,
    status: "active",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
    limit: { context: 100000, output: 16000 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    time: { released: 1 },
  },
  {
    providerID: "opencode",
    id: "beta-free",
    name: "Beta Free",
    type: "chat",
    enabled: true,
    status: "active",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
    limit: { context: 100000, output: 16000 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    time: { released: 1 },
  },
]

async function harness({ model = models[0], agent = "build", benchmark = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), "opencode-free-plugin-"))
  const previous = process.env.OPENCODE_FREE_HOME
  process.env.OPENCODE_FREE_HOME = home
  const settings = mergeSettings()
  await saveSettings(settings)
  const catalog = catalogFromModels(models, settings)
  const initial = {
    version: 1,
    catalog,
    health: {},
    routingCounts: {},
    decisions: [],
  }
  await saveState(initial)
  const benchmarks = emptyBenchmarks()
  benchmarks.summaries.build = {
    "opencode/alpha-free#medium": {
      samples: 3,
      quality: 0.45,
      capability: 1,
      reliability: 1,
      ttftMs: 5000,
      tps: 30,
    },
    "opencode/beta-free#medium": {
      samples: 3,
      quality: 0.9,
      capability: 1,
      reliability: 1,
      ttftMs: 3000,
      tps: 50,
    },
  }
  benchmarks.summaries.plan = benchmarks.summaries.build
  await saveBenchmarks(benchmarks)

  const hooks = {}
  const switches = []
  const session = {
    id: "ses_test",
    agent,
    model: { providerID: model.providerID, id: model.id, variant: "medium" },
    metadata: {},
  }
  let closed = false
  const ctx = {
    model: {
      async list() {
        return { data: models }
      },
    },
    session: {
      async hook(name, callback) {
        hooks[name] = callback
        return { dispose: async () => delete hooks[name] }
      },
      async get() {
        return { ...session, model: { ...session.model } }
      },
      async switchModel(input) {
        switches.push(input.model)
        session.model = { ...input.model }
      },
    },
    event: {
      async *subscribe({ signal }) {
        if (signal.aborted) return
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      },
    },
  }
  const cleanup = await OpenCodeFreePlugin.setup(ctx)
  return {
    home,
    hooks,
    switches,
    session,
    benchmark,
    async close() {
      closed = true
      await cleanup?.()
      if (previous === undefined) delete process.env.OPENCODE_FREE_HOME
      else process.env.OPENCODE_FREE_HOME = previous
      await rm(home, { recursive: true, force: true })
    },
  }
}

test("prompt hook switches to the best role model and persists the decision", async () => {
  const h = await harness()
  try {
    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_1",
      prompt: { text: "Implement the feature", files: [] },
      metadata: {},
    })
    assert.deepEqual(h.switches, [{ providerID: "opencode", id: "beta-free", variant: "medium" }])
    const state = await loadState()
    assert.equal(state.lastRoute.type, "prompt")
    assert.equal(state.lastRoute.candidate.key, "opencode/beta-free#medium")
    assert.equal(state.routingCounts["opencode/beta-free#medium"], 1)
  } finally {
    await h.close()
  }
})

test("retry hook cools the failed model, switches to an alternate, and allows retry", async () => {
  const h = await harness()
  try {
    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_1",
      prompt: { text: "Build it", files: [] },
      metadata: {},
    })
    h.switches.length = 0
    const retry = {
      sessionID: "ses_test",
      agent: "build",
      model: { providerID: "opencode", id: "beta-free", variant: "medium" },
      attempt: 2,
      error: { type: "provider.rate-limit", message: "Too many requests", retryAfterMs: 2000 },
      decision: { retry: false },
    }
    await h.hooks.retry(retry)
    assert.deepEqual(retry.decision, { retry: true, delay: 50 })
    assert.deepEqual(h.switches, [{ providerID: "opencode", id: "alpha-free", variant: "medium" }])
    const state = await loadState()
    assert.equal(state.health["opencode/beta-free#medium"].lastError.kind, "rate_limit")
    assert.equal(state.lastRoute.type, "retry")
    assert.equal(state.lastRoute.failed, "opencode/beta-free#medium")
  } finally {
    await h.close()
  }
})

test("paid selections and benchmark sessions are not routed", async () => {
  const h = await harness({
    model: { providerID: "openai", id: "paid-model" },
  })
  try {
    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_1",
      prompt: { text: "Use paid model", files: [] },
      metadata: {},
    })
    assert.equal(h.switches.length, 0)
    h.session.model = { providerID: "opencode", id: "alpha-free", variant: "medium" }
    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_2",
      prompt: { text: "Benchmark", files: [] },
      metadata: { opencodeFreeBenchmark: true },
    })
    assert.equal(h.switches.length, 0)
  } finally {
    await h.close()
  }
})

test("all exhausted retries stop instead of looping", async () => {
  const h = await harness()
  try {
    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_1",
      prompt: { text: "Build it", files: [] },
      metadata: {},
    })
    // Exhaust the configured failover budget directly.
    for (let index = 0; index < 4; index += 1) {
      const retry = {
        sessionID: "ses_test",
        agent: "build",
        model: h.session.model,
        attempt: index + 2,
        error: { type: "provider.rate-limit", message: "Too many requests" },
        decision: { retry: true, delay: 1 },
      }
      await h.hooks.retry(retry)
      if (retry.decision.retry === false) break
    }
    const retry = {
      sessionID: "ses_test",
      agent: "build",
      model: h.session.model,
      attempt: 10,
      error: { type: "provider.rate-limit", message: "Too many requests" },
      decision: { retry: true, delay: 1 },
    }
    await h.hooks.retry(retry)
    assert.deepEqual(retry.decision, { retry: false })
  } finally {
    await h.close()
  }
})
