import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { catalogFromModels } from "../src/catalog.js"
import { PROBE_VERSION } from "../src/constants.js"
import {
  LauncherError,
  buildOpencodeConfig,
  findExecutable,
  hasProbeData,
  prepareOpencodeLaunch,
  waitForChild,
  withStandalone,
} from "../src/launcher.js"
import {
  emptyProbes,
  emptyState,
  mergeSettings,
  saveProbes,
  saveSettings,
  saveState,
} from "../src/state.js"

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

async function home(t) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-free-launch-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bin = join(directory, "bin")
  await mkdir(bin)
  await writeFile(join(bin, "opencode"), "#!/bin/sh\nexit 0\n", "utf8")
  await chmod(join(bin, "opencode"), 0o755)
  return {
    OPENCODE_FREE_HOME: join(directory, "state"),
    PATH: bin,
  }
}

async function withCatalog(env) {
  const settings = await saveSettings(
    mergeSettings({ probe: { onAssign: false } }),
    env,
  )
  const catalog = catalogFromModels(models, settings)
  await saveState({ ...emptyState(), catalog }, env)
  return { settings, catalog }
}

test("launcher config merges routed models into existing inline config", async (t) => {
  const env = await home(t)
  await withCatalog(env)
  const existing = {
    theme: "keep-me",
    model: "paid/model",
    small_model: "paid/small",
    agent: {
      plan: { model: "paid/planner", variant: "high", temperature: 0.1 },
      custom: { description: "My agent", model: "paid/custom" },
    },
  }
  const prepared = await prepareOpencodeLaunch({
    env: {
      ...env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(existing),
    },
  })

  assert.equal(prepared.initialized, false)
  assert.equal(prepared.catalogCount, 2)
  assert.equal(prepared.routes.build.candidate.providerID, "opencode")
  assert.equal(prepared.config.theme, "keep-me")
  assert.equal(prepared.config.model, prepared.routes.build.candidate.key)
  assert.equal(
    prepared.config.small_model,
    `${prepared.routes.fast.candidate.providerID}/${prepared.routes.fast.candidate.id}`,
  )
  assert.equal(
    prepared.config.agent.plan.model,
    `opencode/${prepared.routes.plan.candidate.id}`,
  )
  assert.equal(prepared.config.agent.plan.temperature, 0.1)
  assert.equal(prepared.config.agent.plan.variant, prepared.routes.plan.candidate.variant)
  assert.deepEqual(prepared.config.agent.custom, existing.agent.custom)
  assert.equal(prepared.config.agent.explore.model, `opencode/${prepared.routes.fast.candidate.id}`)
  assert.equal(prepared.config.agent.compaction.model, `opencode/${prepared.routes.fast.candidate.id}`)
  assert.equal(JSON.parse(prepared.env.OPENCODE_CONFIG_CONTENT).model, prepared.config.model)
  assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined)
})

test("first launch initializes an empty catalog without benchmarking", async (t) => {
  const env = await home(t)
  const settings = await saveSettings(
    mergeSettings({ probe: { onAssign: false } }),
    env,
  )
  await saveState({ ...emptyState() }, env)
  let calls = 0
  const prepared = await prepareOpencodeLaunch({
    env,
    discover: async ({ executable }) => {
      calls += 1
      assert.equal(executable, join(env.PATH, "opencode"))
      const catalog = catalogFromModels(models, settings)
      return catalog
    },
  })
  assert.equal(calls, 1)
  assert.equal(prepared.initialized, true)
  assert.equal(prepared.catalogCount, 2)
  assert.equal(prepared.hasProbes, false)
})

test("probe history is detected from saved results", async (t) => {
  const env = await home(t)
  await withCatalog(env)
  await saveProbes({
    ...emptyProbes(),
    updatedAt: new Date().toISOString(),
    probes: { "opencode/alpha-free": { at: new Date().toISOString() } },
  }, env)
  const prepared = await prepareOpencodeLaunch({ env })
  assert.equal(prepared.hasProbes, true)
})

test("launch probes stale assignment candidates and reuses fresh results", async (t) => {
  const env = await home(t)
  await withCatalog(env)
  await saveSettings(
    mergeSettings({ probe: { onAssign: true, successTtlMs: 60_000 } }),
    env,
  )
  const calls = []
  const probeModels = async ({ models }) => {
    calls.push(models)
    const probes = emptyProbes()
    for (const key of models) {
      probes.probes[key] = {
        at: new Date().toISOString(),
        durationMs: 100,
        responseOk: true,
        measurementVersion: PROBE_VERSION,
      }
    }
    await saveProbes(probes, env)
  }
  const first = await prepareOpencodeLaunch({ env, probeModels })
  assert.equal(first.routes.build.candidate.id, "alpha-free")
  assert.equal(calls.length, 1)
  assert.ok(calls[0].length >= 1)

  const second = await prepareOpencodeLaunch({ env, probeModels })
  assert.equal(second.routes.build.candidate.id, "alpha-free")
  assert.equal(calls.length, 1)
})

test("automatic probe failure does not prevent launch", async (t) => {
  const env = await home(t)
  await withCatalog(env)
  await saveSettings(mergeSettings({ probe: { onAssign: true } }), env)
  const prepared = await prepareOpencodeLaunch({
    env,
    probeModels: async () => {
      throw new Error("probe server unavailable")
    },
  })
  assert.equal(prepared.routes.build.candidate.id, "alpha-free")
})

test("route config does not create missing roles or paid fallbacks", () => {
  const config = buildOpencodeConfig({
    existing: { agent: { build: { temperature: 0.2 } } },
    routes: {
      build: { candidate: { providerID: "opencode", id: "free", variant: "medium" } },
      plan: {},
      fast: {},
    },
  })
  assert.equal(config.agent.build.model, "opencode/free")
  assert.equal(config.agent.build.variant, "medium")
  assert.equal(config.agent.build.temperature, 0.2)
  assert.equal(config.agent.plan, undefined)
  assert.equal(config.agent.explore, undefined)
})

test("launcher rejects missing free routes and malformed inline config", async (t) => {
  const env = await home(t)
  const settings = await saveSettings(
    mergeSettings({ probe: { onAssign: false } }),
    env,
  )
  await saveState({
    ...emptyState(),
    catalog: catalogFromModels([], settings),
  }, env)
  await assert.rejects(
    prepareOpencodeLaunch({ env }),
    (error) => error instanceof LauncherError && /No eligible free model/.test(error.message),
  )

  await withCatalog(env)
  await assert.rejects(
    prepareOpencodeLaunch({ env: { ...env, OPENCODE_CONFIG_CONTENT: "{broken" } }),
    /OPENCODE_CONFIG_CONTENT must contain valid JSON/,
  )
  await assert.rejects(
    prepareOpencodeLaunch({
      env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: [] }) },
    }),
    /OPENCODE_CONFIG_CONTENT\.agent must be a JSON object/,
  )
})

test("standalone is inserted before pass-through arguments", () => {
  assert.deepEqual(withStandalone([]), ["--standalone"])
  assert.deepEqual(withStandalone(["run", "hello"]), ["run", "hello", "--standalone"])
  assert.deepEqual(withStandalone(["run", "--", "--port", "4"]), [
    "run",
    "--standalone",
    "--",
    "--port",
    "4",
  ])
  assert.deepEqual(withStandalone(["--server", "http://localhost:1"]), [
    "--server",
    "http://localhost:1",
  ])
})

test("probe detector handles empty and populated data", () => {
  assert.equal(hasProbeData({}), false)
  assert.equal(hasProbeData({ probes: {} }), false)
  assert.equal(hasProbeData({ probes: { "opencode/x": {} } }), true)
})

test("findExecutable uses PATH and reports a helpful error", async (t) => {
  const env = await home(t)
  assert.equal(await findExecutable("opencode", env), join(env.PATH, "opencode"))
  await assert.rejects(
    findExecutable("missing-opencode", env),
    /Install OpenCode 2\.x/,
  )
})

test("waitForChild returns exit codes and maps signals", async () => {
  const normal = new EventEmitter()
  const normalExit = waitForChild(normal)
  normal.emit("exit", 7, null)
  assert.equal(await normalExit, 7)

  const signaled = new EventEmitter()
  const signaledExit = waitForChild(signaled)
  signaled.emit("exit", null, "SIGTERM")
  assert.equal(await signaledExit, 143)
})
