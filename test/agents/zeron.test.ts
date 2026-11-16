import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { createZeron } from "../../src/agents/zeron.ts"
import { hostedPrompt } from "../../src/agents/agent.ts"
import type { McpClient } from "../../src/shared/mcp.ts"
import { tempHome } from "../helpers.ts"

type Call = { name: string; args: Record<string, unknown>; signal?: AbortSignal }

function fixture(override?: (call: Call) => unknown, options: { timeoutMs?: number; now?: () => number } = {}) {
  const paths = tempHome()
  const directory = path.join(paths.projects, "acme")
  fs.mkdirSync(directory)
  const bin = path.join(paths.home, ".local/bin")
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(path.join(bin, "zeron"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const calls: Call[] = []
  const events: string[] = []
  let harness = "claude-code"
  let env: Record<string, string | undefined> | undefined
  const client: McpClient = {
    async call(name, args, request) {
      const call = { name, args, signal: request?.signal }
      calls.push(call)
      events.push(name)
      const result = override?.(call)
      if (result !== undefined) return await result
      if (name === "whoami") return { localDeviceId: "local-device" }
      if (name === "list_harnesses") return { harnesses: ["claude-code", "codex", "pi"].map((id) => ({ id, connected: true, reasoningLevels: ["low", "high"], accessModes: ["full-access"] })) }
      if (name === "list_models") return { models: ["gpt-test", "claude-test", "anthropic/custom"].map((id) => ({ id, reasoningLevels: ["low", "high"] })) }
      if (name === "create_chat") {
        harness = args.harness as string
        return { chatId: "chat-1", kind: "chat", deviceId: "local-device", parentChatId: null }
      }
      if (name === "get_chat") return { id: "chat-1", deviceId: "local-device", cwd: directory, parentChatId: null, harness, status: "completed", sessionStatus: "idle", statusStale: false, messageCount: 2 }
      if (name === "send_message") return { chatId: "chat-1", delivery: "run" }
      if (name === "wait_for_turn") return completed()
      if (name === "interrupt_chat") return { chatId: "chat-1", commandId: "interrupt-1" }
      throw new Error(`unexpected call ${name}`)
    },
    async close() { events.push("close") },
  }
  const agent = createZeron(async (_command, args, input) => {
    assert.deepEqual(args, ["mcp"])
    env = input?.env
    input?.onStart?.(123)
    return client
  }, options)
  return { paths, directory, agent, calls, events, env: () => env, input: { directory, prompt: "Reply OK", model: null, effort: null, title: "AUT-1 Test" } }
}

function completed(changes: Record<string, unknown> = {}) {
  return {
    chatId: "chat-1",
    turn: {
      outcome: "completed", status: "completed", statusStale: false, timedOut: false, pendingInput: null,
      replies: [{ role: "assistant", status: "complete", text: "intermediate" }, { role: "assistant", status: "complete", text: "Final report" }],
      ...changes,
    },
  }
}

test("Zeron runs locally and persists a standalone session before sending its prompt", async () => {
  const f = fixture()
  const out = await f.agent.run(f.paths, {
    ...f.input, model: "gpt-test", effort: "high",
    env: { NTNCODE_RUN: "RUN-1", ZERON_CHAT_ID: "parent", ZERON_DEVICE_ID: "remote-device" },
    onSession(session) { assert.equal(session, "chat-1"); f.events.push("persist") },
  })
  assert.deepEqual([out.ok, out.reply, out.session, out.usage], [true, "Final report", "chat-1", null])
  assert.equal(out.resume, null, "MCP doesn't expose the workspace locator required for a valid deep link")
  assert.ok(f.events.indexOf("persist") < f.events.indexOf("send_message"))
  const created = f.calls.find((call) => call.name === "create_chat")!.args
  assert.deepEqual(created, { kind: "chat", device: "local-device", cwd: f.directory, cloud: false, harness: "codex", model: "gpt-test", reasoning: "high", access: "full-access", sandbox: "danger-full-access", title: "AUT-1 Test", wait: false })
  assert.ok(!Object.hasOwn(created, "prompt"))
  assert.deepEqual(f.calls.find((call) => call.name === "send_message")!.args, { chat: "chat-1", text: hostedPrompt({ ...f.input, env: { NTNCODE_RUN: "RUN-1" } }), wait: false })
  assert.equal(f.env()!.ZERON_CHAT_ID, undefined)
  assert.equal(f.env()!.ZERON_DEVICE_ID, undefined)
  assert.equal(f.events.at(-1), "close")
  assert.ok(!f.calls.some((call) => call.name === "interrupt_chat"))
})

test("Zeron supports explicit harness/provider/model and rejects unknown model or effort", async () => {
  const f = fixture()
  assert.equal(f.agent.settingsError("ambiguous-model"), "Model: Zeron needs a gpt-* or claude-* model, or harness/model, such as pi/anthropic/claude-fable-5-2")
  assert.equal(f.agent.settingsError("pi/anthropic/custom"), null)
  const out = await f.agent.run(f.paths, { ...f.input, model: "pi/anthropic/custom" })
  assert.equal(out.ok, true)
  assert.equal(f.calls.find((call) => call.name === "create_chat")!.args.harness, "pi")
  assert.equal(f.calls.find((call) => call.name === "create_chat")!.args.model, "anthropic/custom")
  for (const change of [{ model: "codex/gpt-missing", effort: null }, { model: "gpt-test", effort: "max" as const }]) {
    const bad = fixture()
    const result = await bad.agent.run(bad.paths, { ...bad.input, ...change })
    assert.equal(result.ok, false)
    assert.match(result.error!, /Model:|Effort:/u)
    assert.ok(!bad.calls.some((call) => call.name === "create_chat"))
  }
})

test("Zeron stops a chat waiting for input and preserves the session for inspection", async () => {
  const f = fixture(({ name }) => name === "wait_for_turn" ? completed({ outcome: "awaitingInput", status: "awaitingInput", pendingInput: { requestId: "q1" } }) : undefined)
  const out = await f.agent.run(f.paths, f.input)
  assert.equal(out.ok, false)
  assert.match(out.error!, /waiting for input/u)
  assert.equal(out.session, "chat-1")
  assert.ok(f.calls.some((call) => call.name === "interrupt_chat"))
})

test("Zeron never counts stale state or an empty final reply as successful completion", async () => {
  for (const changes of [{ statusStale: true }, { replies: [] }]) {
    const f = fixture(({ name }) => name === "wait_for_turn" ? completed(changes) : undefined)
    const out = await f.agent.run(f.paths, f.input)
    assert.equal(out.ok, false)
    assert.match(out.error!, /stale|no final reply/u)
    assert.ok(f.calls.some((call) => call.name === "interrupt_chat"))
  }
})

test("Zeron polls a timed-out wait and bounds the complete run", async () => {
  let clock = 0
  let waits = 0
  const f = fixture(({ name }) => {
    if (name !== "wait_for_turn") return undefined
    waits += 1
    clock += 10
    return completed({ outcome: "timedOut", timedOut: true, replies: [] })
  }, { timeoutMs: 15, now: () => clock })
  const out = await f.agent.run(f.paths, f.input)
  assert.equal(waits, 2)
  assert.equal(out.ok, false)
  assert.match(out.error!, /timed out/u)
  assert.ok(f.calls.some((call) => call.name === "interrupt_chat"))
})

test("Zeron refuses another device, a parented chat, or the wrong working folder before sending", async () => {
  for (const change of [{ deviceId: "remote" }, { parentChatId: "parent" }, { cwd: "/tmp" }]) {
    const f = fixture(({ name }) => name === "get_chat" ? { id: "chat-1", deviceId: "local-device", cwd: f.directory, parentChatId: null, harness: "claude-code", status: "completed", sessionStatus: "idle", statusStale: false, messageCount: 2, ...change } : undefined)
    const out = await f.agent.run(f.paths, f.input)
    assert.equal(out.ok, false)
    assert.match(out.error!, /local standalone|working folder/u)
    assert.ok(!f.calls.some((call) => call.name === "send_message"))
    assert.ok(f.calls.some((call) => call.name === "interrupt_chat"))
  }
})

test("Zeron does not start execution when persisting the new session fails", async () => {
  const f = fixture()
  const out = await f.agent.run(f.paths, { ...f.input, onSession() { throw new Error("state disk full") } })
  assert.equal(out.ok, false)
  assert.equal(out.session, "chat-1")
  assert.match(out.error!, /state disk full/u)
  assert.ok(!f.calls.some((call) => call.name === "send_message"))
  assert.ok(f.calls.some((call) => call.name === "interrupt_chat"))
})

test("Zeron aborts waiting execution and interrupts without reusing the aborted signal", async () => {
  const controller = new AbortController()
  const f = fixture(({ name }) => {
    if (name === "wait_for_turn") { controller.abort(new Error("scheduler stopped")); throw controller.signal.reason }
    return undefined
  })
  const out = await f.agent.run(f.paths, { ...f.input, signal: controller.signal })
  assert.equal(out.ok, false)
  assert.match(out.error!, /scheduler stopped/u)
  assert.ok(f.calls.some((call) => call.name === "interrupt_chat"))
  assert.equal(f.calls.find((call) => call.name === "interrupt_chat")!.signal, undefined)
  const stopped = fixture()
  await stopped.agent.run(stopped.paths, { ...stopped.input, signal: controller.signal })
  assert.equal(stopped.calls.length, 0)
})

test("Zeron recovery cancellation validates the local session before interrupting", async () => {
  const f = fixture()
  await f.agent.cancel(f.paths, "chat-1")
  assert.deepEqual(f.calls.map((call) => call.name), ["whoami", "get_chat", "interrupt_chat", "get_chat"])
  const remote = fixture(({ name }) => name === "get_chat" ? { id: "chat-1", deviceId: "remote", cwd: "/tmp", parentChatId: null, harness: "codex" } : undefined)
  await assert.rejects(remote.agent.cancel(remote.paths, "chat-1"), /local standalone/u)
  assert.ok(!remote.calls.some((call) => call.name === "interrupt_chat"))
})

test("Zeron cancellation confirms native idle after the interrupt acknowledgement", async () => {
  let interrupted = false
  let polls = 0
  const f = fixture(({ name }) => {
    if (name === "interrupt_chat") interrupted = true
    if (name === "get_chat" && interrupted && polls++ < 2) return { id: "chat-1", deviceId: "local-device", cwd: f.directory, parentChatId: null, harness: "codex", status: "working", sessionStatus: "working", statusStale: false }
    return undefined
  })
  await f.agent.cancel(f.paths, "chat-1")
  assert.equal(polls, 3)
  assert.equal(f.calls.at(-1)!.name, "get_chat")
})

test("Zeron exposes an unconfirmed interruption failure for scheduler recovery", async () => {
  const f = fixture(({ name }) => {
    if (name === "wait_for_turn") throw new Error("engine disconnected")
    if (name === "interrupt_chat") throw new Error("bridge disconnected before interruption")
    return undefined
  })
  const out = await f.agent.run(f.paths, f.input)
  assert.equal(out.ok, false)
  assert.equal(out.session, "chat-1")
  assert.match(out.error!, /engine disconnected; couldn't interrupt the chat: bridge disconnected/u)
})

test("Zeron confirms an errored native session through its terminal turn instead of assuming it is running", async () => {
  const f = fixture(({ name }) => {
    if (name === "get_chat") return { id: "chat-1", deviceId: "local-device", cwd: f.directory, parentChatId: null, harness: "codex", status: "errored", sessionStatus: "errored", statusStale: false }
    if (name === "wait_for_turn") return completed({ outcome: "errored", status: "errored", replies: [] })
    return undefined
  })
  await f.agent.cancel(f.paths, "chat-1")
  assert.ok(f.calls.some((call) => call.name === "wait_for_turn"))
})

test("Zeron doctor checks the local engine and reports harness MCP inspection as unverified", async () => {
  const f = fixture()
  const checks = await f.agent.checks(f.paths, ["notion", "executor"])
  assert.equal(checks[0]!.ok, true)
  assert.equal(checks[1]!.ok, true)
  assert.equal(checks[2]!.ok, false)
  assert.equal(checks[2]!.level, "warning")
  assert.match(checks[2]!.detail, /unverified/u)
})
