import test from "node:test"
import assert from "node:assert/strict"
import { selectDueModels } from "../src/benchmark.js"
import { catalogFromModels, modelKey, selectVariant } from "../src/catalog.js"
import { BENCHMARK_VERSION } from "../src/constants.js"
import { emptyBenchmarks, mergeSettings } from "../src/state.js"

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
  const benchmarks = emptyBenchmarks()
  benchmarks.catalogFingerprint = catalog.fingerprint
  const updatedAt = new Date().toISOString()
  for (const role of ["plan", "build"]) {
    benchmarks.summaries[role] = {
      [modelKey({ ...model, variant: selectVariant(model, role, settings.profile) })]: {
        quality: 0.8,
        measurementVersion: BENCHMARK_VERSION,
        updatedAt,
      },
    }
  }
  return benchmarks
}

test("skips fresh cached benchmark results", () => {
  assert.deepEqual(
    selectDueModels({
      models: catalog.models,
      settings,
      benchmarks: seeded(),
      catalog,
    }),
    [],
  )
})

test("reruns when the catalog fingerprint changes", () => {
  const benchmarks = seeded()
  benchmarks.catalogFingerprint = "old"
  assert.equal(
    selectDueModels({ models: catalog.models, settings, benchmarks, catalog }).length,
    1,
  )
})

test("reruns stale results and honors refresh", () => {
  const benchmarks = seeded()
  const stale = Date.now() + settings.benchmark.cacheTtlMs + 1000
  assert.equal(
    selectDueModels({
      models: catalog.models,
      settings,
      benchmarks,
      catalog,
      now: stale,
    }).length,
    1,
  )
  assert.equal(
    selectDueModels({
      models: catalog.models,
      settings,
      benchmarks: seeded(),
      catalog,
      refresh: true,
    }).length,
    1,
  )
})
