import test from "node:test"
import assert from "node:assert/strict"
import { catalogFromModels, modelChoices } from "../src/catalog.js"
import { recordFailure, recordSuccess } from "../src/health.js"
import { chooseModel, roleForAgent } from "../src/router.js"
import { emptyBenchmarks, emptyState, mergeSettings } from "../src/state.js"

const settings = mergeSettings()
const catalog = catalogFromModels(
  [
    model("alpha", 20),
    model("beta", 10),
    model("vision", 15, ["text", "image"]),
  ],
  settings,
)

function model(id, context = 100000, input = ["text"]) {
  return {
    providerID: "opencode",
    id,
    name: id,
    type: "chat",
    enabled: true,
    status: "active",
    capabilities: { tools: true, input, output: ["text"] },
    variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
    limit: { context, output: 32000 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    time: { released: 1 },
  }
}

function seed() {
  const state = emptyState()
  state.catalog = catalog
  const benchmarks = emptyBenchmarks()
  benchmarks.summaries.plan = {
    "opencode/alpha#medium": summary(0.95, 5000, 45),
    "opencode/beta#medium": summary(0.45, 2000, 60),
    "opencode/vision#medium": summary(0.5, 7000, 30),
  }
  benchmarks.summaries.build = {
    "opencode/alpha#medium": summary(0.65, 5000, 45),
    "opencode/beta#medium": summary(0.7, 2000, 60),
    "opencode/vision#medium": summary(0.4, 7000, 30),
  }
  return { state, benchmarks }
}

function summary(quality, ttftMs, tps) {
  return {
    samples: 3,
    quality,
    capability: 1,
    reliability: 1,
    ttftMs,
    tps,
    durationMs: 10_000,
  }
}

test("maps agents including Relay roles to routing roles", () => {
  assert.equal(roleForAgent("plan"), "plan")
  assert.equal(roleForAgent("build"), "build")
  assert.equal(roleForAgent("planner"), "plan")
  assert.equal(roleForAgent("implementer"), "build")
  assert.equal(roleForAgent("verifier"), "verify")
  assert.equal(roleForAgent("orchestrator"), "fast")
  assert.equal(roleForAgent("code-review"), "verify")
})

test("chooses the highest role utility and exposes alternatives", () => {
  const { state, benchmarks } = seed()
  const result = chooseModel({ catalog, state, benchmarks, settings, role: "plan" })
  assert.equal(result.candidate.id, "alpha")
  assert.equal(result.decision.reason, "best_score")
  assert.ok(result.decision.quality > 0.9)
  assert.equal(result.alternatives.length, 2)
})

test("build profile balances quality and speed", () => {
  const { state, benchmarks } = seed()
  const result = chooseModel({ catalog, state, benchmarks, settings, role: "build" })
  assert.equal(result.candidate.id, "beta")
})

test("keeps a current healthy model when scores are close", () => {
  const { state, benchmarks } = seed()
  const fast = mergeSettings({ profile: "fast" })
  const current = modelChoices(catalog, "build", fast.profile).find((item) => item.id === "vision")
  const result = chooseModel({
    catalog,
    state,
    benchmarks,
    settings: fast,
    role: "build",
    current,
  })
  assert.equal(result.candidate.id, "vision")
  assert.equal(result.decision.reason, "sticky")
})

test("respects image requirements", () => {
  const { state, benchmarks } = seed()
  const result = chooseModel({
    catalog,
    state,
    benchmarks,
    settings,
    role: "plan",
    prompt: { files: [{ uri: "file:///tmp/screenshot.png" }] },
  })
  assert.equal(result.candidate.id, "vision")
  assert.equal(result.decision.needsVision, true)
})

test("excludes cooling models and retried candidates", () => {
  const { state, benchmarks } = seed()
  recordFailure(state, "opencode/alpha#medium", { type: "provider.rate-limit", retryAfterMs: 60_000 }, settings)
  const result = chooseModel({
    catalog,
    state,
    benchmarks,
    settings,
    role: "plan",
    exclude: ["opencode/vision#medium"],
  })
  assert.equal(result.candidate.id, "beta")
})

test("honors a role pin and falls back when unavailable", () => {
  const { state, benchmarks } = seed()
  const pinned = mergeSettings({ pinnedModels: { plan: "opencode/beta#medium" } })
  let result = chooseModel({ catalog, state, benchmarks, settings: pinned, role: "plan" })
  assert.equal(result.candidate.id, "beta")
  assert.equal(result.decision.reason, "pinned")
  recordFailure(state, "opencode/beta#medium", { type: "provider.rate-limit" }, pinned)
  result = chooseModel({ catalog, state, benchmarks, settings: pinned, role: "plan" })
  assert.equal(result.candidate.id, "alpha")
  assert.equal(result.decision.reason, "pinned_unavailable")
})

test("benchmark-disqualified models are hard-gated", () => {
  const { state, benchmarks } = seed()
  benchmarks.summaries.plan["opencode/alpha#medium"] = {
    ...benchmarks.summaries.plan["opencode/alpha#medium"],
    disqualified: true,
    disqualifyReason: "timed out",
  }
  const result = chooseModel({ catalog, state, benchmarks, settings, role: "plan" })
  assert.notEqual(result.candidate.id, "alpha")
})

test("live success improves reliability and cooldown expires", () => {
  const { state } = seed()
  const key = "opencode/beta#medium"
  recordSuccess(state, key, { ttftMs: 1000, durationMs: 3000, tps: 60 })
  const result = chooseModel({ catalog, state, benchmarks: emptyBenchmarks(), settings, role: "build" })
  assert.ok(result.all.find((item) => item.key === key).reliability > 0.7)
  recordFailure(state, key, { type: "provider.timeout" }, settings)
  const cooled = chooseModel({ catalog, state, benchmarks: emptyBenchmarks(), settings, role: "build" })
  assert.notEqual(cooled.candidate.key, key)
})
