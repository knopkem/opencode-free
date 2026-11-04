import { mkdir, lstat, readlink, rm, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export function pluginSource() {
  return fileURLToPath(new URL("./plugin.js", import.meta.url))
}

export function pluginTarget(env = process.env) {
  const configHome = env.OPENCODE_CONFIG_DIR
    ? env.OPENCODE_CONFIG_DIR
    : join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
  return join(configHome, "plugins", "opencode-free.js")
}

export async function installPlugin(env = process.env) {
  const source = pluginSource()
  const target = pluginTarget(env)
  await mkdir(dirname(target), { recursive: true })
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink()) {
      const current = resolve(dirname(target), await readlink(target))
      if (current === resolve(source)) return { target, source, changed: false }
      throw new Error(`Refusing to replace existing plugin symlink at ${target}`)
    }
    throw new Error(`Refusing to replace existing file at ${target}`)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  await symlink(source, target)
  return { target, source, changed: true }
}

export async function uninstallPlugin(env = process.env) {
  const source = pluginSource()
  const target = pluginTarget(env)
  try {
    const info = await lstat(target)
    if (!info.isSymbolicLink()) {
      throw new Error(`Refusing to remove non-symlink at ${target}`)
    }
    const current = resolve(dirname(target), await readlink(target))
    if (current !== resolve(source)) {
      throw new Error(`Refusing to remove a symlink not owned by opencode-free: ${target}`)
    }
    await rm(target)
    return { target, removed: true }
  } catch (error) {
    if (error?.code === "ENOENT") return { target, removed: false }
    throw error
  }
}
