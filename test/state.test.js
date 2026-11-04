import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadSettings,
  loadState,
  mergeSettings,
  saveSettings,
  statePaths,
  updateState,
} from "../src/state.js"

async function home(t) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-free-state-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { OPENCODE_FREE_HOME: directory }
}

test("settings merge clamps unsafe values and preserves defaults", () => {
  const settings = mergeSettings({
    profile: "unknown",
    maxFailovers: 999,
    rateLimitCooldownMs: -1,
    providers: ["opencode", "other"],
  })
  assert.equal(settings.profile, "balanced")
  assert.equal(settings.maxFailovers, 10)
  assert.equal(settings.rateLimitCooldownMs, 1_000)
  assert.deepEqual(settings.providers, ["opencode", "other"])
  assert.equal(settings.benchmark.quickTimeoutMs, 60_000)
  assert.equal(settings.benchmark.quickConcurrency, 3)
  assert.equal(settings.benchmark.fullConcurrency, 1)
})

test("settings round-trip through the state directory", async (t) => {
  const env = await home(t)
  const saved = await saveSettings(
    {
      ...mergeSettings(),
      profile: "quality",
      pinnedModels: { plan: "opencode/beam-free#high" },
    },
    env,
  )
  const loaded = await loadSettings(env)
  assert.equal(loaded.profile, "quality")
  assert.equal(saved.pinnedModels.plan, "opencode/beam-free#high")
  assert.equal(loaded.pinnedModels.plan, "opencode/beam-free#high")
})

test("concurrent updates do not lose state", async (t) => {
  const env = await home(t)
  await Promise.all(
    Array.from({ length: 20 }, () =>
      updateState((state) => {
        state.routingCounts["opencode/x"] = Number(state.routingCounts["opencode/x"] || 0) + 1
        return state
      }, env),
    ),
  )
  const state = await loadState(env)
  assert.equal(state.routingCounts["opencode/x"], 20)
})

test("corrupt state falls back to an empty document", async (t) => {
  const env = await home(t)
  await writeFile(statePaths(env).state, "{not json", "utf8")
  const state = await loadState(env)
  assert.deepEqual(state.health, {})
  assert.deepEqual(state.catalog.models, [])
})
