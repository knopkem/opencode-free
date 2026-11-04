import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installPlugin, pluginSource, pluginTarget, uninstallPlugin } from "../src/install.js"

test("installs and removes only its own plugin symlink", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opencode-free-install-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const env = { OPENCODE_CONFIG_DIR: join(home, "config") }
  const target = pluginTarget(env)
  const installed = await installPlugin(env)
  assert.equal(installed.changed, true)
  assert.equal(installed.target, target)
  assert.equal(await readlink(target), pluginSource())
  assert.equal((await installPlugin(env)).changed, false)
  const removed = await uninstallPlugin(env)
  assert.equal(removed.removed, true)
  assert.equal((await uninstallPlugin(env)).removed, false)
})

test("refuses to overwrite a user file", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "opencode-free-install-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const env = { OPENCODE_CONFIG_DIR: join(home, "config") }
  const target = pluginTarget(env)
  await mkdir(join(home, "config", "plugins"), { recursive: true })
  await writeFile(target, "user file", "utf8")
  await assert.rejects(() => installPlugin(env), /Refusing to replace/)
})
