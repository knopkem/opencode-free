import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { catalogFromModels } from "../src/catalog.js"
import {
  emptyState,
  loadSettings,
  mergeSettings,
  saveSettings,
  saveState,
} from "../src/state.js"

const exec = promisify(execFile)
const bin = fileURLToPath(new URL("../bin/opencode-free.js", import.meta.url))
const ocf = fileURLToPath(new URL("../bin/ocf.js", import.meta.url))

async function home(t) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-free-cli-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { OPENCODE_FREE_HOME: directory }
}

async function run(env, args) {
  const { stdout } = await exec(process.execPath, [bin, ...args], { env })
  return stdout
}

test("ignore-provider and allow-provider update provider exclusions", async (t) => {
  const env = await home(t)

  let output = JSON.parse(await run(env, ["ignore-provider", "subscription", "--json"]))
  assert.deepEqual(output.excludeProviders, ["subscription"])

  output = JSON.parse(await run(env, ["ignore-provider", "another", "--json"]))
  assert.deepEqual(output.excludeProviders, ["subscription", "another"])

  output = JSON.parse(await run(env, ["ignore-provider", "subscription", "--json"]))
  assert.deepEqual(output.excludeProviders, ["subscription", "another"])

  output = JSON.parse(await run(env, ["allow-provider", "subscription", "--json"]))
  assert.deepEqual(output.excludeProviders, ["another"])
  const settings = await loadSettings(env)
  assert.deepEqual(settings.excludeProviders, ["another"])
})

test("provider exclusion commands reject invalid provider IDs", async (t) => {
  const env = await home(t)
  for (const value of ["provider/model", "*", "two words"]) {
    await assert.rejects(
      run(env, ["ignore-provider", value]),
      (error) => error.code === 2,
    )
  }
})

test("full benchmark mode is rejected with a clear error", async (t) => {
  const env = await home(t)
  await assert.rejects(
    run(env, ["benchmark", "--full"]),
    (error) => {
      assert.equal(error.code, 2)
      assert.match(error.stderr, /Full quality benchmarking was removed/)
      return true
    },
  )
})

test("ocf with no arguments launches OpenCode using routed models", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-free-ocf-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const env = {
    OPENCODE_FREE_HOME: join(directory, "state"),
    OPENCODE_CONFIG_CONTENT: "",
    OCF_CAPTURE_CONFIG: join(directory, "config.json"),
    OCF_CAPTURE_ARGS: join(directory, "args.txt"),
    PATH: join(directory, "bin"),
  }
  await mkdir(env.PATH)
  await writeFile(
    join(env.PATH, "opencode"),
    '#!/bin/sh\nprintf "%s" "$OPENCODE_CONFIG_CONTENT" > "$OCF_CAPTURE_CONFIG"\nprintf "%s\\n" "$@" > "$OCF_CAPTURE_ARGS"\nexit 0\n',
    "utf8",
  )
  await chmod(join(env.PATH, "opencode"), 0o755)

  const settings = await saveSettings(
    mergeSettings({ probe: { onAssign: false } }),
    env,
  )
  const catalog = catalogFromModels(
    [
      {
        providerID: "opencode",
        id: "free-model",
        name: "Free Model",
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
  await saveState({ ...emptyState(), catalog }, env)

  const { stdout } = await exec(process.execPath, [ocf], { env })
  assert.match(stdout, /Starting OpenCode with plan=opencode\/free-model#medium/)
  assert.match(stdout, /No availability probes yet/)
  const config = JSON.parse(await readFile(env.OCF_CAPTURE_CONFIG, "utf8"))
  assert.equal(config.model, "opencode/free-model#medium")
  assert.equal(config.agent.build.model, "opencode/free-model")
  assert.equal(config.agent.build.variant, "medium")
  assert.equal(config.agent.explore.variant, "low")
  assert.equal((await readFile(env.OCF_CAPTURE_ARGS, "utf8")).trim(), "--standalone")

  const passed = await exec(process.execPath, [ocf, "run", "hello world"], { env })
  assert.match(passed.stdout, /Starting OpenCode with/)
  assert.equal(
    (await readFile(env.OCF_CAPTURE_ARGS, "utf8")).trim(),
    "run\nhello world\n--standalone",
  )
})
