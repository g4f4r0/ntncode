import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { McpClient } from "../../src/shared/mcp.ts"
import { createT3Code } from "../../src/agents/t3-code.ts"
import { tempHome } from "../helpers.ts"

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }) })

function fixture(overrides: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> = {}) {
  const paths = tempHome(); homes.push(paths.home)
  const directory = path.join(paths.projects, "exact"); fs.mkdirSync(directory)
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const providers = [{ providerInstanceId: "codex", canRunChildTask: true, constraints: [], models: [{ id: "gpt-test", options: [{ id: "reasoningEffort", values: ["low", "high"] }] }] }]
  const read = (items: unknown[] = [{ type: "assistant_message", itemId: "answer", runId: "run", position: 1, text: "done" }]) => ({ thread: { pendingRequestCount: 0 }, items, nextPosition: null, hasMore: false })
  const defaults: Record<string, (args: Record<string, unknown>) => unknown> = {
    orchestrator_capabilities: () => ({ providers }),
    t3_project_list: () => ({ projects: [{ id: "parent", workspaceRoot: paths.projects }], nextCursor: null }),
    t3_project_create: () => ({ id: "project", workspaceRoot: directory }),
    t3_thread_launch: () => ({ threadId: "thread", runId: null }),
    t3_thread_send: () => ({ runId: "run" }),
    t3_thread_wait: () => ({ threadId: "thread", runId: "run", status: "completed", timedOut: false }),
    t3_thread_read: () => read(),
    t3_thread_interrupt: () => ({ status: "no_active_run" }),
  }
  let closed = 0
  const client: McpClient = {
    async call(name, args) { calls.push({ name, args }); const fn = overrides[name] ?? defaults[name]; if (!fn) throw new Error(`unexpected ${name}`); return fn(args) },
    async close() { closed++ },
  }
  const agent = createT3Code(async () => client)
  const input = { prompt: "do work", directory, model: "gpt-test", effort: "low" as const, title: "automation" }
  return { paths, directory, calls, providers, read, agent, input, closed: () => closed }
}

describe("T3 Code automation", () => {
  test("registers the exact cwd and persists an idle thread before sending, with validated effort", async () => {
    const f = fixture()
    const result = await f.agent.run(f.paths, { ...f.input, onSession(session) { expect(session).toBe("thread"); expect(f.calls.at(-1)?.name).toBe("t3_thread_launch") } })
    expect(result).toMatchObject({ ok: true, reply: "done", session: "thread", usage: null })
    expect(f.calls.find((c) => c.name === "t3_project_create")?.args).toMatchObject({ workspaceRoot: f.directory, createWorkspaceRootIfMissing: false })
    const launch = f.calls.find((c) => c.name === "t3_thread_launch")!.args
    expect(launch).toMatchObject({ projectId: "project", workspaceStrategy: { type: "root" }, runtimeMode: "full-access", modelSelection: { instanceId: "codex", model: "gpt-test", options: [{ id: "reasoningEffort", value: "low" }] } })
    expect(launch).not.toHaveProperty("message")
    expect(f.closed()).toBe(1)
  })

  test("preserves app defaults when Model and Effort are empty", async () => {
    const f = fixture()
    expect((await f.agent.run(f.paths, { ...f.input, model: null, effort: null })).ok).toBe(true)
    expect(f.calls.some((c) => c.name === "orchestrator_capabilities")).toBe(false)
    expect(f.calls.find((c) => c.name === "t3_thread_launch")?.args).not.toHaveProperty("modelSelection")
    expect(f.agent.settingsError(null, "high")).toContain("set Model")
  })

  test("accepts nullable fields from T3's real response schema", async () => {
    let f: ReturnType<typeof fixture>
    f = fixture({
      orchestrator_capabilities: () => ({ providers: [{ providerInstanceId: "codex", canRunChildTask: true, constraints: [], models: [{ id: "gpt-test", options: null }] }] }),
      t3_thread_wait: () => ({ threadId: "thread", runId: "run", status: "completed", timedOut: false, resultRun: null }),
      t3_thread_read: () => f.read([{ type: "user_message", itemId: "prompt", runId: null, position: 0, text: null }, { type: "assistant_message", itemId: "answer", runId: "run", position: 1, text: "done" }]),
    })
    expect((await f.agent.run(f.paths, { ...f.input, effort: null })).ok).toBe(true)
  })

  test("rejects ambiguous models and unsupported effort before creating work", async () => {
    const f = fixture()
    f.providers.push({ ...f.providers[0]!, providerInstanceId: "other" })
    expect((await f.agent.run(f.paths, f.input)).error).toContain("multiple providers")
    expect(f.calls.some((c) => c.name === "t3_thread_launch")).toBe(false)
    expect((await f.agent.run(f.paths, { ...f.input, model: "codex/gpt-test", effort: "max" })).error).toContain("doesn't support max")
  })

  test("reads the settled result run, paginates messages, and retrieves every reply chunk", async () => {
    let f: ReturnType<typeof fixture>
    f = fixture({
      t3_thread_wait: () => ({ threadId: "thread", runId: "run", status: "completed", timedOut: false, resultRun: { runId: "settled", status: "completed" } }),
      t3_thread_read: (args) => args.itemId ? f.read([{ type: "assistant_message", itemId: "final", runId: "settled", position: 3, text: "tail", textTruncated: false }]) : args.afterPosition ? f.read([{ type: "assistant_message", itemId: "final", runId: "settled", position: 3, text: "head", textTruncated: true, nextTextOffset: 4 }]) : { ...f.read([{ type: "assistant_message", itemId: "old", runId: "run", position: 1, text: "wrong" }]), hasMore: true, nextPosition: 1 },
    })
    expect((await f.agent.run(f.paths, f.input)).reply).toBe("headtail")
    expect(f.calls.filter((c) => c.name === "t3_thread_read")).toHaveLength(3)
  })

  test("doesn't report stale or input-waiting runs as success", async () => {
    const f = fixture({ t3_thread_wait: () => ({ threadId: "thread", runId: "run", status: "waiting_for_input", timedOut: false }) })
    expect((await f.agent.run(f.paths, f.input)).error).toContain("waiting_for_input")
    expect(f.calls.some((c) => c.name === "t3_thread_interrupt")).toBe(true)
  })

  test("cancels if persistence fails, before sending the prompt", async () => {
    const f = fixture()
    const result = await f.agent.run(f.paths, { ...f.input, onSession() { throw new Error("disk full") } })
    expect(result.error).toContain("disk full")
    expect(f.calls.some((c) => c.name === "t3_thread_send")).toBe(false)
    expect(f.calls.some((c) => c.name === "t3_thread_interrupt")).toBe(true)
  })

  test("cancellation confirms engine stop and propagates unknown status", async () => {
    const f = fixture({ t3_thread_interrupt: () => ({ status: "interrupt_requested" }), t3_thread_wait: () => ({ threadId: "thread", runId: "run", status: "interrupted", timedOut: false }) })
    await f.agent.cancel!(f.paths, "thread")
    expect(f.calls.map((c) => c.name)).toEqual(["t3_thread_interrupt", "t3_thread_wait"])
    expect(f.closed()).toBe(1)
    const g = fixture({ t3_thread_interrupt: () => ({ status: "interrupt_requested" }), t3_thread_wait: () => ({ threadId: "thread", runId: "run", status: "offline", timedOut: false }) })
    await expect(g.agent.cancel!(g.paths, "thread")).rejects.toThrow("unconfirmed")
  })

  test("waits for delegated work even when interrupt reports no active run", async () => {
    const f = fixture()
    await f.agent.cancel!(f.paths, "thread")
    expect(f.calls.map((c) => c.name)).toEqual(["t3_thread_interrupt", "t3_thread_wait"])
    expect(f.calls[1]!.args.untilDelegatedWorkSettled).toBe(true)
    const wrong = fixture({ t3_thread_wait: () => ({ threadId: "another-thread", runId: null, status: "idle", timedOut: false }) })
    await expect(wrong.agent.cancel!(wrong.paths, "thread")).rejects.toThrow("another thread")
  })

  test("abort after persistence stops the owned thread without starting work", async () => {
    const f = fixture(); const controller = new AbortController()
    const result = await f.agent.run(f.paths, { ...f.input, signal: controller.signal, onSession: () => controller.abort() })
    expect(result.ok).toBe(false)
    expect(f.calls.some((c) => c.name === "t3_thread_send")).toBe(false)
    expect(f.calls.some((c) => c.name === "t3_thread_interrupt")).toBe(true)
  })
})
