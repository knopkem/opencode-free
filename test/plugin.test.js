import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCodeFreePlugin } from "../src/plugin.js"
import { catalogFromModels, modelKey } from "../src/catalog.js"
import { loadState, mergeSettings, saveSettings, saveState } from "../src/state.js"

const models = [
  {
    providerID: "opencode",
    id: "deepseek-v4.1-flash-free",
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
    id: "glm-5.3-flash-free",
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
  {
    providerID: "opencode",
    id: "big-pickle",
    name: "Big Pickle",
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

async function harness({ model = models[0], agent = "build", settings: overrides = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), "opencode-free-plugin-"))
  const previous = process.env.OPENCODE_FREE_HOME
  process.env.OPENCODE_FREE_HOME = home
  const settings = mergeSettings({
    routing: { exploreUnmapped: 0 },
    ...overrides,
    ...(overrides.routing
      ? { routing: { exploreUnmapped: 0, ...overrides.routing } }
      : {}),
  })
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
  const hooks = {}
  const switches = []
  const events = []
  const eventWaiters = []
  const emit = (event) => {
    events.push(event)
    eventWaiters.shift()?.()
  }
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  const session = {
    id: "ses_test",
    agent,
    model: model ? { providerID: model.providerID, id: model.id, variant: "medium" } : undefined,
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
        return {
          ...session,
          model: session.model ? { ...session.model } : undefined,
        }
      },
      async switchModel(input) {
        switches.push(input.model)
        session.model = { ...input.model }
      },
    },
    event: {
      async *subscribe({ signal }) {
        while (!signal.aborted) {
          if (events.length) {
            yield events.shift()
            continue
          }
          await new Promise((resolve) => {
            const wake = () => {
              signal.removeEventListener("abort", wake)
              resolve()
            }
            eventWaiters.push(wake)
            signal.addEventListener("abort", wake, { once: true })
          })
        }
      },
    },
  }
  const cleanup = await OpenCodeFreePlugin.setup(ctx)
  return {
    home,
    hooks,
    switches,
    session,
    emit,
    async selectModel(model) {
      session.model = { ...model }
      emit({
        type: "session.model.selected",
        data: { sessionID: session.id, model: { ...model } },
      })
      await tick()
    },
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
  const h = await harness({ model: null })
  try {
    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_1",
      prompt: { text: "Implement the feature", files: [] },
      metadata: {},
    })
    assert.deepEqual(h.switches, [{ providerID: "opencode", id: "glm-5.3-flash-free", variant: "medium" }])
    const state = await loadState()
    assert.equal(state.lastRoute.type, "prompt")
    assert.equal(state.lastRoute.candidate.key, "opencode/glm-5.3-flash-free#medium")
    assert.equal(state.routingCounts["opencode/glm-5.3-flash-free#medium"], 1)
  } finally {
    await h.close()
  }
})

test("manual model selection disables automatic routing for the session", async () => {
  const h = await harness({ model: null })
  try {
    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_1",
      prompt: { text: "Implement the feature", files: [] },
      metadata: {},
    })
    assert.deepEqual(h.switches, [
      { providerID: "opencode", id: "glm-5.3-flash-free", variant: "medium" },
    ])
    h.switches.length = 0

    await h.selectModel({ providerID: "opencode", id: "deepseek-v4.1-flash-free", variant: "low" })
    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_2",
      prompt: { text: "Keep using my selection", files: [] },
      metadata: {},
    })

    assert.deepEqual(h.switches, [])
    const state = await loadState()
    assert.equal(state.decisions.length, 1)
  } finally {
    await h.close()
  }
})

test("the plugin's own model selection event keeps routing active", async () => {
  const h = await harness({ model: null })
  try {
    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_1",
      prompt: { text: "Implement the feature", files: [] },
      metadata: {},
    })
    h.emit({
      type: "session.model.selected",
      data: {
        sessionID: "ses_test",
        model: { providerID: "opencode", id: "glm-5.3-flash-free", variant: "medium" },
      },
    })
    await new Promise((resolve) => setImmediate(resolve))
    h.switches.length = 0
    await saveSettings(
      {
        ...mergeSettings(),
        pinnedModels: { build: "opencode/deepseek-v4.1-flash-free#medium" },
      },
      process.env,
    )

    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_2",
      prompt: { text: "Continue", files: [] },
      metadata: {},
    })
    assert.deepEqual(h.switches, [
      { providerID: "opencode", id: "deepseek-v4.1-flash-free", variant: "medium" },
    ])
  } finally {
    await h.close()
  }
})

test("a missed manual selection event is detected at the next prompt", async () => {
  const h = await harness({ model: null })
  try {
    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_1",
      prompt: { text: "Implement the feature", files: [] },
      metadata: {},
    })
    h.switches.length = 0
    h.session.model = { providerID: "opencode", id: "deepseek-v4.1-flash-free", variant: "low" }

    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_2",
      prompt: { text: "Continue with my choice", files: [] },
      metadata: {},
    })
    assert.deepEqual(h.switches, [])
    const state = await loadState()
    assert.equal(state.decisions.length, 1)
  } finally {
    await h.close()
  }
})

test("model-local failures cool only that model and fail over", async () => {
  const h = await harness({ model: null })
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
      model: { providerID: "opencode", id: "glm-5.3-flash-free", variant: "medium" },
      attempt: 2,
      error: { type: "provider.invalid-output", message: "Invalid output" },
      decision: { retry: false },
    }
    await h.hooks.retry(retry)
    assert.deepEqual(retry.decision, { retry: true, delay: 50 })
    assert.equal(h.switches.length, 1)
    assert.notEqual(h.switches[0].id, "glm-5.3-flash-free")
    const state = await loadState()
    assert.equal(state.health["opencode/glm-5.3-flash-free#medium"].lastError.kind, "invalid_output")
    assert.equal(state.providerHealth?.opencode?.consecutiveFailures || 0, 0)
    assert.equal(state.lastRoute.type, "retry")
    assert.equal(state.lastRoute.failed, "opencode/glm-5.3-flash-free#medium")
  } finally {
    await h.close()
  }
})

test("provider-wide rate limits stop instead of cycling through models", async () => {
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
      model: { providerID: "opencode", id: "glm-5.3-flash-free", variant: "medium" },
      attempt: 2,
      error: {
        type: "provider.rate-limit",
        message: "Provider-wide rate limit",
        retryAfterMs: 60_000,
      },
      decision: { retry: false },
    }
    await h.hooks.retry(retry)
    assert.deepEqual(retry.decision, { retry: false })
    assert.deepEqual(h.switches, [])
    const state = await loadState()
    assert.equal(state.lastRoute.reason, "provider_cooldown")
    assert.equal(state.lastRoute.failureScope, "provider")
    assert.equal(state.lastRoute.providerID, "opencode")
    assert.ok(state.providerHealth.opencode.cooldownUntil > Date.now())
    assert.equal(state.health["opencode/glm-5.3-flash-free#medium"], undefined)
  } finally {
    await h.close()
  }
})

test("unmapped exploration is chosen once per session and persists", async () => {
  const h = await harness({
    settings: { routing: { exploreUnmapped: 1 } },
  })
  try {
    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_1",
      prompt: { text: "Build it", files: [] },
      metadata: {},
    })
    assert.deepEqual(h.switches, [
      { providerID: "opencode", id: "big-pickle", variant: "medium" },
    ])
    const state = await loadState()
    assert.equal(state.lastRoute.reason, "explore_unmapped")
    assert.ok(state.exploration["opencode/big-pickle#medium"])
    h.switches.length = 0

    await h.hooks.prompt({
      sessionID: "ses_test",
      messageID: "msg_2",
      prompt: { text: "Continue", files: [] },
      metadata: {},
    })
    assert.deepEqual(h.switches, [])
  } finally {
    await h.close()
  }
})

test("paid selections are not routed", async () => {
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
