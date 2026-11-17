import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { assertHostedEnvironment, hostedPrompt } from "../../src/agents/agent.ts"
import { runShell } from "../../src/shared/process.ts"
import { tempHome } from "../helpers.ts"

test("hosted alerts receive the run context with shell-safe values and no scheduler credentials", async () => {
  const paths = tempHome()
  const bin = path.join(paths.home, "bin")
  fs.mkdirSync(bin)
  const title = "A 'quote'; $(touch /should-never-run)"
  fs.writeFileSync(path.join(bin, "ntncode"), '#!/bin/sh\nprintf "%s" "$NTNCODE_AUTOMATION_TITLE"\n', { mode: 0o755 })
  const prompt = hostedPrompt({ prompt: "Work.", directory: paths.home, title: "Run", model: null, effort: null, env: { NTNCODE_AUTOMATION_TITLE: title, NTNCODE_RUN: "RUN-1", NOTION_ACCESS_TOKEN: "ntn_never_forward", OTHER_SECRET: "secret-never-forward" } })
  const command = prompt.split("\n").find((line) => line.startsWith("env "))!
  const result = await runShell(command, { env: { PATH: `${bin}:${process.env.PATH}` } })
  assert.equal(result.code, 0)
  assert.equal(result.stdout, title)
  assert.doesNotMatch(prompt, /ntn_never_forward|secret-never-forward/u)
  fs.rmSync(paths.home, { recursive: true, force: true })
})

test("a hosted engine carrying the scheduler token is rejected without exposing the token", { skip: process.platform !== "linux" }, async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},30000)"], { env: { ...process.env, NOTION_ACCESS_TOKEN: "ntn_do_not_print_this_value" }, stdio: "ignore" })
  await new Promise<void>((resolve) => child.once("spawn", resolve))
  try {
    assert.throws(() => assertHostedEnvironment(child.pid!), (error: unknown) => {
      assert.match((error as Error).message, /NOTION_ACCESS_TOKEN/u)
      assert.doesNotMatch((error as Error).message, /ntn_do_not_print/u)
      return true
    })
  } finally { child.kill() }
})
