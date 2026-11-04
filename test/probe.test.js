import test from "node:test"
import assert from "node:assert/strict"
import {
  providerLimitFromRun,
  selectAssignmentCandidates,
  selectDueProbeModels,
  selectProbeModels,
} from "../src/probe.js"
import { probeStateFor, probeTtlFor } from "../src/availability.js"
import { classifyError } from "../src/health.js"
import { baseKey, catalogFromModels } from "../src/catalog.js"
import { PROBE_VERSION } from "../src/constants.js"
import { emptyProbes, emptyState, mergeSettings } from "../src/state.js"

const settings = mergeSettings()
const catalog = catalogFromModels(
  [
    {
      providerID: "opencode",
      id: "free",
      name: "Free",
      type: "chat",
      enabled: true,
      status: "active",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      variants: [{ id: "low" }, { id: "medium" }, { id: "high" }],
      limit: { context: 100000, output: 16000 },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      time: { released: 1 },
    },
  ],
  settings,
)
const model = catalog.models[0]

function seeded() {
  const probes = emptyProbes()
  probes.catalogFingerprint = catalog.fingerprint
  probes.probes[baseKey(model)] = {
    at: new Date().toISOString(),
    measurementVersion: PROBE_VERSION,
  }
  return probes
}

test("selects assignment candidates instead of only the current winner", () => {
  const selected = selectProbeModels(catalog, settings, [], { state: emptyState() })
  assert.ok(selected.length >= 1)
  assert.equal(selected[0].id, "free")
  const direct = selectAssignmentCandidates(catalog, settings, emptyState(), { perRole: 4 })
  assert.deepEqual(direct.map((model) => model.id), ["free"])
})

test("explicit model selection bypasses the route shortlist", () => {
  const selected = selectProbeModels(catalog, settings, ["opencode/free"])
  assert.equal(selected.length, 1)
  assert.equal(selected[0].id, "free")
})

test("skips fresh cached probes", () => {
  assert.deepEqual(
    selectDueProbeModels({
      models: catalog.models,
      settings,
      probes: seeded(),
    }),
    [],
  )
})

test("catalog changes preserve per-model probe cache", () => {
  const probes = seeded()
  probes.catalogFingerprint = "old"
  assert.equal(
    selectDueProbeModels({ models: catalog.models, settings, probes }).length,
    0,
  )
})

test("reruns stale probes after the success TTL and always honors refresh", () => {
  assert.equal(
    selectDueProbeModels({
      models: catalog.models,
      settings,
      probes: seeded(),
      now: Date.now() + 61 * 60_000,
    }).length,
    1,
  )
  assert.equal(
    selectDueProbeModels({
      models: catalog.models,
      settings,
      probes: seeded(),
      refresh: true,
    }).length,
    1,
  )
})

test("fresh probes remain cached within the success TTL", () => {
  assert.deepEqual(
    selectDueProbeModels({
      models: catalog.models,
      settings,
      probes: seeded(),
      now: Date.now() + 30 * 60_000,
    }),
    [],
  )
})

test("probe freshness is shorter for failures than access errors", () => {
  const now = Date.now()
  const at = new Date(now - 20 * 60_000).toISOString()
  const timeout = probeStateFor(
    { at, error: { type: "provider.timeout", message: "Timed out" } },
    settings,
    now,
  )
  assert.equal(timeout.available, true)
  assert.equal(timeout.fresh, false)
  const auth = probeStateFor(
    { at, error: { type: "provider.auth", message: "Unauthorized" } },
    settings,
    now,
  )
  assert.equal(auth.available, false)
  assert.equal(auth.fresh, true)
  assert.equal(probeTtlFor("auth", settings), 6 * 60 * 60_000)
})

test("probe detects provider-scoped quota failures only", () => {
  assert.equal(
    providerLimitFromRun(
      {
        key: "opencode/free#medium",
        error: { type: "provider.rate-limit", message: "Provider limit" },
      },
      settings,
    ),
    "opencode",
  )
  assert.equal(
    providerLimitFromRun(
      {
        key: "opencode/free#medium",
        error: { type: "provider.timeout", message: "Timed out" },
      },
      settings,
    ),
    undefined,
  )
})

test("free usage messages are classified as quota even with status 429", () => {
  assert.equal(
    classifyError({
      type: "ProviderRequestError",
      status: 429,
      message: "Free usage limit reached. Upgrade for more.",
    }),
    "quota",
  )
  assert.equal(
    classifyError({
      type: "ProviderRequestError",
      status: 429,
      message: "Too many requests",
    }),
    "rate_limit",
  )
})
