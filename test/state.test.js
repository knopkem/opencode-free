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
  assert.deepEqual(mergeSettings().providers, ["*"])
  assert.deepEqual(mergeSettings().excludeProviders, [])
  const settings = mergeSettings({
    profile: "unknown",
    maxFailovers: 999,
    rateLimitCooldownMs: -1,
    providers: ["opencode", "other"],
    excludeProviders: ["subscription"],
    limitScopes: { backup: "model" },
  })
  assert.equal(settings.profile, "balanced")
  assert.equal(settings.maxFailovers, 10)
  assert.equal(settings.rateLimitCooldownMs, 1_000)
  assert.deepEqual(settings.providers, ["opencode", "other"])
  assert.deepEqual(settings.excludeProviders, ["subscription"])
  assert.equal(settings.probe.onAssign, true)
  assert.equal(settings.probe.timeoutMs, 10_000)
  assert.equal(settings.probe.concurrency, 2)
  assert.equal(settings.probe.candidatesPerRole, 4)
  assert.equal(settings.probe.successTtlMs, 60 * 60_000)
  assert.equal(settings.probe.failureTtlMs, 10 * 60_000)
  assert.equal(settings.routing.diversity, "auto")
  assert.equal(settings.routing.maxQualityLoss, 0.03)
  assert.equal(settings.routing.exploreUnmapped.plan, 0.02)
  assert.equal(settings.routing.exploreUnmapped.fast, 0.05)
  assert.equal(settings.limitScopes.opencode, "provider")
  assert.equal(settings.limitScopes.backup, "model")
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

test("migration drops legacy provider-wide limit failures from model reliability", async (t) => {
  const env = await home(t)
  await writeFile(
    statePaths(env).state,
    JSON.stringify({
      version: 1,
      health: {
        "opencode/model#medium": {
          state: "cooldown",
          cooldownUntil: Date.now() + 60_000,
          lastError: { kind: "rate_limit" },
          recent: [
            { ok: false, kind: "rate_limit" },
            { ok: false, kind: "timeout" },
          ],
        },
      },
      providerHealth: {},
      routingCounts: {},
      decisions: [],
    }),
    "utf8",
  )
  const state = await loadState(env)
  const health = state.health["opencode/model#medium"]
  assert.deepEqual(health.recent, [{ ok: false, kind: "timeout" }])
  assert.equal(health.lastError, null)
  assert.equal(health.cooldownUntil, 0)
  assert.equal(health.consecutiveFailures, 1)
  assert.equal(state.version, 3)
})
