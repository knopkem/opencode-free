import test from "node:test"
import assert from "node:assert/strict"
import { catalogFromModels, modelChoices } from "../src/catalog.js"
import { recordFailure, recordSuccess } from "../src/health.js"
import {
  chooseModel,
  chooseRoutes,
  explorationRate,
  roleForAgent,
  selectExplorationCandidate,
} from "../src/router.js"
import { emptyState, mergeSettings } from "../src/state.js"

const settings = mergeSettings()
const catalog = catalogFromModels(
  [
    model("deepseek-v4.1-flash-free"),
    model("glm-5.3-flash-free"),
    model("vision", 15, ["text", "image"]),
  ],
  settings,
)

function model(id, context = 100000, input = ["text"], providerID = "opencode") {
  return {
    providerID,
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

test("maps agents including Relay roles to routing roles", () => {
  assert.equal(roleForAgent("plan"), "plan")
  assert.equal(roleForAgent("build"), "build")
  assert.equal(roleForAgent("planner"), "plan")
  assert.equal(roleForAgent("implementer"), "build")
  assert.equal(roleForAgent("verifier"), "verify")
  assert.equal(roleForAgent("orchestrator"), "fast")
  assert.equal(roleForAgent("code-review"), "verify")
})

test("chooses the highest public-prior role utility", () => {
  const result = chooseModel({
    catalog,
    state: emptyState(),
    settings,
    role: "plan",
  })
  assert.equal(result.candidate.id, "deepseek-v4.1-flash-free")
  assert.equal(result.decision.reason, "best_score")
  assert.equal(result.decision.qualitySource, "public-benchmark-family-estimate")
  assert.equal(result.alternatives.length, 2)
})

test("live speed can make a slightly lower-prior build model win", () => {
  const state = emptyState()
  recordSuccess(
    state,
    "opencode/glm-5.3-flash-free#medium",
    { ttftMs: 100, durationMs: 1000, tps: 100 },
  )
  const result = chooseModel({ catalog, state, settings, role: "build" })
  assert.equal(result.candidate.id, "glm-5.3-flash-free")
})

test("keeps a current healthy model when scores are close", () => {
  const state = emptyState()
  const result = chooseModel({
    catalog,
    state,
    settings,
    role: "plan",
    current: { providerID: "opencode", id: "glm-5.3-flash-free", variant: "medium" },
  })
  assert.equal(result.candidate.id, "glm-5.3-flash-free")
  assert.equal(result.decision.reason, "sticky")
})

test("respects image requirements", () => {
  const result = chooseModel({
    catalog,
    state: emptyState(),
    settings,
    role: "plan",
    prompt: { files: [{ uri: "file:///tmp/screenshot.png" }] },
  })
  assert.equal(result.candidate.id, "vision")
  assert.equal(result.decision.needsVision, true)
})

test("excludes cooling models and retried candidates", () => {
  const state = emptyState()
  recordFailure(state, "opencode/deepseek-v4.1-flash-free#medium", { type: "provider.timeout" }, settings)
  const result = chooseModel({
    catalog,
    state,
    settings,
    role: "plan",
    exclude: ["opencode/vision#medium"],
  })
  assert.equal(result.candidate.id, "glm-5.3-flash-free")
})

test("honors a role pin and falls back when unavailable", () => {
  const state = emptyState()
  const pinned = mergeSettings({ pinnedModels: { plan: "opencode/glm-5.3-flash-free#medium" } })
  let result = chooseModel({ catalog, state, settings: pinned, role: "plan" })
  assert.equal(result.candidate.id, "glm-5.3-flash-free")
  assert.equal(result.decision.reason, "pinned")
  recordFailure(state, "opencode/glm-5.3-flash-free#medium", { type: "provider.timeout" }, pinned)
  result = chooseModel({ catalog, state, settings: pinned, role: "plan" })
  assert.equal(result.candidate.id, "deepseek-v4.1-flash-free")
  assert.equal(result.decision.reason, "pinned_unavailable")
})

test("live success improves reliability and cooldown expires", () => {
  const state = emptyState()
  const key = "opencode/glm-5.3-flash-free#medium"
  recordSuccess(state, key, { ttftMs: 1000, durationMs: 3000, tps: 60 })
  const result = chooseModel({ catalog, state, settings, role: "build" })
  assert.ok(result.all.find((item) => item.key === key).reliability > 0.7)
  recordFailure(state, key, { type: "provider.timeout" }, settings)
  const cooled = chooseModel({ catalog, state, settings, role: "build" })
  assert.notEqual(cooled.candidate.key, key)
})

test("fresh probe failures temporarily exclude otherwise stronger models", () => {
  const probes = {
    probes: {
      "opencode/deepseek-v4.1-flash-free": {
        at: new Date().toISOString(),
        responseOk: false,
        error: { type: "provider.timeout", message: "Timed out" },
      },
    },
  }
  const result = chooseModel({
    catalog,
    state: emptyState(),
    probes,
    settings,
    role: "plan",
    exclude: ["opencode/vision#medium"],
  })
  assert.equal(result.candidate.id, "glm-5.3-flash-free")
  const blocked = result.all.find((item) => item.key.startsWith("opencode/deepseek"))
  assert.equal(blocked.excludedReason, "probe_unavailable")
})

test("probe failures fall back to prior ranking when every candidate is blocked", () => {
  const at = new Date().toISOString()
  const probes = {
    probes: {
      "opencode/deepseek-v4.1-flash-free": {
        at,
        responseOk: false,
        error: { type: "provider.timeout", message: "Timed out" },
      },
      "opencode/glm-5.3-flash-free": {
        at,
        responseOk: false,
        error: { type: "provider.timeout", message: "Timed out" },
      },
      "opencode/vision": {
        at,
        responseOk: false,
        error: { type: "provider.timeout", message: "Timed out" },
      },
    },
  }
  const result = chooseModel({
    catalog,
    state: emptyState(),
    probes,
    settings,
    role: "plan",
  })
  assert.equal(result.candidate.id, "deepseek-v4.1-flash-free")
  assert.equal(result.decision.probeFallback, true)
})

test("fresh probe latency supplies a low-confidence speed signal", () => {
  const at = new Date().toISOString()
  const probes = {
    probes: {
      "opencode/deepseek-v4.1-flash-free": {
        at,
        responseOk: true,
        durationMs: 15_000,
      },
      "opencode/glm-5.3-flash-free": {
        at,
        responseOk: true,
        durationMs: 100,
      },
    },
  }
  const result = chooseModel({
    catalog,
    state: emptyState(),
    probes,
    settings,
    role: "plan",
  })
  assert.equal(result.candidate.id, "glm-5.3-flash-free")
  assert.equal(result.decision.probeLatencyMs, 100)
})

test("unmapped models receive the median mapped prior and remain eligible", () => {
  const mixedCatalog = catalogFromModels(
    [
      model("deepseek-v4.1-flash-free"),
      model("glm-5.3-flash-free"),
      model("big-pickle"),
    ],
    settings,
  )
  const result = chooseModel({
    catalog: mixedCatalog,
    state: emptyState(),
    settings,
    role: "build",
  })
  const unknown = result.all.find((item) => item.key === "opencode/big-pickle#medium")
  assert.equal(unknown.priorKnown, false)
  assert.equal(unknown.qualitySource, "neutral")
  assert.ok(unknown.quality > 0.8 && unknown.quality < 0.9)
})

test("exploration rate can be configured globally or by role", () => {
  const global = mergeSettings({ routing: { exploreUnmapped: 0.1 } })
  assert.equal(explorationRate(global, "plan"), 0.1)
  assert.equal(explorationRate(settings, "plan"), 0.02)
  assert.equal(explorationRate(settings, "fast"), 0.05)
  const disabled = mergeSettings({ routing: { exploreUnmapped: 0 } })
  assert.equal(explorationRate(disabled, "build"), 0)
})

test("exploration selects the least-used healthy unmapped model", () => {
  const mixedCatalog = catalogFromModels(
    [model("deepseek-v4.1-flash-free"), model("big-pickle"), model("beam-free")],
    settings,
  )
  const state = emptyState()
  state.routingCounts["opencode/big-pickle#medium"] = 2
  const explorationSettings = mergeSettings({ routing: { exploreUnmapped: 1 } })
  const key = selectExplorationCandidate({
    catalog: mixedCatalog,
    state,
    settings: explorationSettings,
    role: "build",
    random: () => 0,
  })
  assert.equal(key, "opencode/beam-free#medium")
})

test("a forced exploration route bypasses the public-prior ranking", () => {
  const mixedCatalog = catalogFromModels(
    [model("deepseek-v4.1-flash-free"), model("big-pickle")],
    settings,
  )
  const routes = chooseRoutes({
    catalog: mixedCatalog,
    state: emptyState(),
    settings,
    forcedKeys: { build: "opencode/big-pickle#medium" },
  })
  assert.equal(routes.roles.build.candidate.id, "big-pickle")
  assert.equal(routes.roles.build.decision.reason, "explore_unmapped")
})

test("automatic diversity stays off with a single provider", () => {
  const diverseCatalog = catalogFromModels([model("alpha"), model("beta")], settings)
  const routes = chooseRoutes({
    catalog: diverseCatalog,
    state: emptyState(),
    settings,
  })
  assert.equal(routes.diversity.enabled, false)
  assert.equal(routes.diversity.providerCount, 1)
  assert.equal(routes.roles.plan.candidate.id, "alpha")
  assert.equal(routes.roles.build.candidate.id, "alpha")
})

test("automatic diversity spreads across independent providers", () => {
  const multiSettings = mergeSettings({ providers: ["opencode", "backup"] })
  const multiCatalog = catalogFromModels(
    [
      { ...model("alpha"), providerID: "opencode" },
      { ...model("beta"), providerID: "backup" },
    ],
    multiSettings,
  )
  const routes = chooseRoutes({
    catalog: multiCatalog,
    state: emptyState(),
    settings: multiSettings,
  })
  assert.equal(routes.diversity.enabled, true)
  assert.equal(routes.diversity.unit, "provider")
  assert.equal(routes.diversity.providerCount, 2)
  const providers = new Set([
    routes.roles.plan.candidate.providerID,
    routes.roles.build.candidate.providerID,
  ])
  assert.deepEqual([...providers].sort(), ["backup", "opencode"])
  assert.equal(routes.roles.build.decision.reason, "role_diversity")
})

test("explicit model diversity still works within one provider", () => {
  const diverseCatalog = catalogFromModels([model("alpha"), model("beta")], settings)
  const routes = chooseRoutes({
    catalog: diverseCatalog,
    state: emptyState(),
    settings: mergeSettings({ routing: { diversity: true } }),
  })
  assert.equal(routes.diversity.enabled, true)
  assert.equal(routes.diversity.unit, "model")
  assert.equal(routes.roles.plan.candidate.id, "alpha")
  assert.equal(routes.roles.build.candidate.id, "beta")
})

test("quality profile keeps every role on its independent best", () => {
  const diverseCatalog = catalogFromModels([model("alpha"), model("beta")], settings)
  const routes = chooseRoutes({
    catalog: diverseCatalog,
    state: emptyState(),
    settings: mergeSettings({ profile: "quality" }),
  })
  assert.equal(routes.diversity.enabled, false)
  assert.equal(routes.roles.plan.candidate.id, "alpha")
  assert.equal(routes.roles.build.candidate.id, "alpha")
})

test("fallback chains omit cooling models", () => {
  const chainCatalog = catalogFromModels([model("alpha"), model("beta")], settings)
  const state = emptyState()
  recordFailure(state, "opencode/alpha#medium", { type: "provider.timeout" }, settings)
  const routes = chooseRoutes({
    catalog: chainCatalog,
    state,
    settings,
  })
  const chain = routes.roles.plan.chain.map((item) => item.key)
  assert.equal(routes.roles.plan.candidate.id, "beta")
  assert.deepEqual(chain, ["opencode/beta#medium"])
})

test("provider-wide rate limits block every model from that provider", () => {
  const providerCatalog = catalogFromModels([model("alpha"), model("beta")], settings)
  const state = emptyState()
  const now = Date.now()
  const failure = recordFailure(
    state,
    "opencode/alpha#medium",
    { type: "provider.rate-limit", retryAfterMs: 60_000 },
    settings,
    now,
  )
  assert.equal(failure.scope, "provider")
  assert.equal(failure.providerID, "opencode")
  assert.ok(state.providerHealth.opencode.cooldownUntil > now)
  assert.equal(state.health["opencode/alpha#medium"], undefined)
  const routes = chooseRoutes({
    catalog: providerCatalog,
    state,
    settings,
    now,
  })
  assert.equal(routes.roles.plan.candidate, undefined)
  assert.equal(routes.roles.plan.decision.reason, "provider_cooldown")
  assert.equal(routes.roles.plan.chain.length, 0)
})

test("provider-wide limits fail over to another eligible provider", () => {
  const multiSettings = mergeSettings({ providers: ["opencode", "backup"] })
  const multiCatalog = catalogFromModels(
    [
      { ...model("alpha"), providerID: "opencode" },
      { ...model("beta"), providerID: "backup" },
    ],
    multiSettings,
  )
  const state = emptyState()
  const now = Date.now()
  recordFailure(
    state,
    "opencode/alpha#medium",
    { type: "provider.rate-limit", retryAfterMs: 60_000 },
    multiSettings,
    now,
  )
  const result = chooseModel({
    catalog: multiCatalog,
    state,
    settings: multiSettings,
    role: "plan",
    now,
  })
  assert.equal(result.candidate.providerID, "backup")
})

test("in-flight success does not clear an active provider cooldown", () => {
  const state = emptyState()
  const now = Date.now()
  recordFailure(
    state,
    "opencode/alpha#medium",
    { type: "provider.rate-limit", retryAfterMs: 60_000 },
    settings,
    now,
  )
  const cooldownUntil = state.providerHealth.opencode.cooldownUntil
  recordSuccess(state, "opencode/alpha#medium", { durationMs: 100 }, now + 1000)
  assert.equal(state.providerHealth.opencode.cooldownUntil, cooldownUntil)
  assert.equal(state.providerHealth.opencode.state, "cooldown")
})

test("provider becomes eligible again after cooldown expires", () => {
  const providerCatalog = catalogFromModels([model("alpha")], settings)
  const state = emptyState()
  const now = Date.now()
  recordFailure(
    state,
    "opencode/alpha#medium",
    { type: "provider.rate-limit", retryAfterMs: 1000 },
    settings,
    now,
  )
  const result = chooseModel({
    catalog: providerCatalog,
    state,
    settings,
    role: "plan",
    now: now + 1001,
  })
  assert.equal(result.candidate.id, "alpha")
})
