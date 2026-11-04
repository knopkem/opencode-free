import test from "node:test"
import assert from "node:assert/strict"
import {
  catalogFromModels,
  isZeroCost,
  modelKey,
  parseKey,
  selectVariant,
} from "../src/catalog.js"
import { mergeSettings } from "../src/state.js"

const settings = mergeSettings()

function model(overrides = {}) {
  return {
    providerID: "opencode",
    id: "generic-stealth",
    name: "Generic Stealth",
    type: "chat",
    enabled: true,
    status: "active",
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [{ id: "low" }, { id: "high" }],
    limit: { context: 200000, output: 32000 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    time: { released: 1 },
    ...overrides,
  }
}

test("detects free models by cost, not name", () => {
  assert.equal(isZeroCost(model()), true)
  assert.equal(isZeroCost(model({ cost: [] })), false)
  assert.equal(isZeroCost(model({ cost: [{ input: 0, output: 0.1, cache: { read: 0, write: 0 } }] })), false)
  assert.equal(
    isZeroCost(
      model({
        cost: [
          { input: 0, output: 0, cache: { read: 0, write: 0 } },
          { input: 1, output: 2, cache: { read: 0, write: 0 } },
        ],
      }),
    ),
    false,
  )
  const catalog = catalogFromModels([model({ id: "big-pickle", name: "Big Pickle" })], settings)
  assert.deepEqual(
    catalog.models.map((item) => item.id),
    ["big-pickle"],
  )
})

test("catalog filters paid, disabled, deprecated, non-tool, and non-chat models", () => {
  const catalog = catalogFromModels(
    [
      model({ id: "free" }),
      model({ id: "paid", cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }] }),
      model({ id: "disabled", enabled: false }),
      model({ id: "deprecated", status: "deprecated" }),
      model({ id: "no-tools", capabilities: { tools: false, input: ["text"], output: ["text"] } }),
      model({ id: "image", type: "image" }),
      model({ id: "other-provider", providerID: "openrouter" }),
    ],
    settings,
  )
  assert.deepEqual(
    catalog.models.map((item) => item.id),
    ["free"],
  )
})

test("variant selection follows role and profile preferences", () => {
  const value = model({ variants: [{ id: "low" }, { id: "medium" }, { id: "high" }] })
  assert.equal(selectVariant(value, "plan", "quality"), "high")
  assert.equal(selectVariant(value, "build", "balanced"), "medium")
  assert.equal(selectVariant(value, "fast", "fast"), "low")
  assert.equal(selectVariant(model({ variants: [] }), "plan", "fast"), undefined)
})

test("model keys round-trip provider, id, and variant", () => {
  assert.equal(modelKey({ providerID: "opencode", id: "x" }), "opencode/x")
  assert.equal(modelKey({ providerID: "opencode", id: "x", variant: "high" }), "opencode/x#high")
  assert.deepEqual(parseKey("opencode/x#high"), {
    providerID: "opencode",
    id: "x",
    variant: "high",
  })
  assert.equal(parseKey("not-a-model"), undefined)
})
