#!/usr/bin/env node
import { CLI_COMMANDS, runCli } from "../src/cli.js"

try {
  const args = process.argv.slice(2)
  const launch = args.length === 0 || !CLI_COMMANDS.has(args[0])
  process.exitCode = await runCli(launch ? ["opencode", ...args] : args)
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
}
