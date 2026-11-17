import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { hostedPrompt } from "../../src/agents/agent.ts"
import { CAPY_API, capyModel, createCapy, type CapyDeps } from "../../src/agents/capy.ts"
import { tempHome } from "../helpers.ts"

type Call = { method: string; route: string; body: any; auth: string | null }
type Reply = { status?: number; body: unknown; headers?: Record<string, string> }

function fixture(override?: (call: Call) => Reply | undefined, deps: Partial<CapyDeps> = {}) {
  const paths = tempHome()
  const directory = path.join(paths.projects, "acme", "shop")
  fs.mkdirSync(directory, { recursive: true })
  fs.mkdirSync(path.join(paths.home, ".capy/bin"), { recursive: true })
  fs.writeFileSync(path.join(paths.home, ".capy/bin/capy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const calls: Call[] = []
  const events: string[] = []
  let polls = 0
  const thread = (status: string, extra: Record<string, unknown> = {}) => ({ id: "jam_1", projectId: "project_shop", status, needsYou: false, ask: null, ...extra })
  const fake: typeof fetch = (async (url: string, init: RequestInit = {}) => {
    const route = String(url).slice(CAPY_API.length)
    const call = { method: init.method ?? "GET", route, body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get("authorization") }
    calls.push(call)
    events.push(`${call.method} ${route.split("?")[0]}`)
    const custom = override?.(call)
    const reply: Reply = custom ?? (() => {
      if (route === "/projects") return { body: { items: [
        { id: "project_other", name: "other", repos: [{ repoFullName: "acme/shop", mode: "secondary" }, { repoFullName: "acme/api", mode: "primary" }] },
        { id: "project_shop", name: "shop", repos: [{ repoFullName: "Acme/Shop", mode: "primary" }] },
      ] } }
      if (route === "/models") return { body: { items: [{ id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", reasoningModes: ["low", "high", "max"] }, { id: "particle/particle-1", name: "Particle-1", reasoningModes: ["none"] }], default: { modelId: "particle/particle-1" } } }
      if (route === "/threads" && call.method === "POST") return { body: thread("working") }
      if (route === "/threads/jam_1") return { body: thread(++polls >= 2 ? "idle" : "working") }
      if (route.startsWith("/threads/jam_1/messages")) {
        const after = new URLSearchParams(route.split("?")[1]).get("after")
        return after
          ? { body: { items: [{ source: "tool", text: "ls" }, { source: "assistant", text: "Final report" }], cursor: null } }
          : { body: { items: [{ source: "user", text: "Work." }, { source: "assistant", text: "intermediate" }], cursor: "01PAGE" } }
      }
      if (route === "/threads/jam_1/interrupt") return { body: { ok: true } }
      throw new Error(`unexpected ${call.method} ${route}`)
    })()
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers })
  }) as typeof fetch
  const agent = createCapy({
    fetch: fake, key: () => "capy_test_key_value", sleep: async () => {}, pollMs: 1,
    dock: () => ({ pid: process.pid, deviceId: "device_1", state: "connected", roots: [path.join(paths.projects, "other"), directory] }),
    origin: async (folder) => (folder === directory ? "acme/shop" : null),
    verifyDock: () => {},
    ...deps,
  })
  const input = { directory, prompt: "Work.", model: null, effort: null, title: "AUT-1 Test" }
  return { paths, directory, agent, calls, events, input, thread }
}

test("Capy maps Notion Code models to its IDs and rejects others in settings", () => {
  assert.equal(capyModel(null), null)
  assert.equal(capyModel("claude-opus-5-5"), "anthropic/claude-opus-5-5")
  assert.equal(capyModel("gpt-6.1-sol"), "openai/gpt-6.1-sol")
  assert.equal(capyModel("claude-code/claude-opus-5-5"), "claude-code/claude-opus-5-5")
  const { agent } = fixture()
  assert.equal(agent.settingsError("google/gemini-4-argon", null), null)
  assert.match(agent.settingsError("Some Model", null)!, /^Model: /u)
})

test("Capy runs on this machine's dock in the exact linked folder and returns the last assistant reply", async () => {
  const f = fixture()
  const out = await f.agent.run(f.paths, {
    ...f.input, model: "claude-opus-5-5", effort: "high", env: { NTNCODE_RUN: "RUN-1" },
    onSession(session) { assert.equal(session, "jam_1"); f.events.push("persist") },
  })
  assert.deepEqual([out.ok, out.reply, out.session, out.error, out.usage], [true, "Final report", "jam_1", null, null])
  const created = f.calls.find((call) => call.route === "/threads")!.body
  assert.match(created.requestId, /^ntncode-[\w-]{36}$/u)
  assert.deepEqual({ ...created, requestId: "x" }, {
    requestId: "x", projectId: "project_shop", title: "AUT-1 Test", message: hostedPrompt({ ...f.input, env: { NTNCODE_RUN: "RUN-1" } }),
    device: { deviceId: "device_1", workspace: { kind: "linked", root: f.directory } },
    model: { modelId: "anthropic/claude-opus-5-5", reasoningMode: "high" },
  })
  assert.ok(f.calls.every((call) => call.auth === "Bearer capy_test_key_value"))
  assert.ok(f.events.indexOf("persist") < f.events.indexOf("GET /threads/jam_1"))
  assert.ok(!f.events.includes("POST /threads/jam_1/interrupt"))
})

test("Capy waits for a new thread that reads idle before the dock picks it up", async () => {
  const states = ["idle", "idle", "working", "idle"]
  let poll = 0
  const f = fixture((call) => {
    if (call.route === "/threads" && call.method === "POST") return { body: { id: "jam_1", projectId: "project_shop", status: "idle" } }
    if (call.route === "/threads/jam_1") return { body: { id: "jam_1", projectId: "project_shop", status: states[Math.min(poll++, 3)] } }
    if (call.route.startsWith("/threads/jam_1/messages") && poll < 3) return { body: { items: [{ source: "user", text: "Work." }], cursor: null } }
    return undefined
  })
  const out = await f.agent.run(f.paths, f.input)
  assert.deepEqual([out.ok, out.reply], [true, "Final report"])
  assert.equal(poll, 4)
})

test("Capy fails a thread its dock never starts, after the pickup window", async () => {
  let clock = 0
  const f = fixture((call) => {
    if (call.route === "/threads/jam_1") {
      clock += 30_000
      return { body: { id: "jam_1", projectId: "project_shop", status: "idle" } }
    }
    if (call.route.startsWith("/threads/jam_1/messages")) return { body: { items: [{ source: "user", text: "Work." }], cursor: null } }
    return undefined
  }, { now: () => clock })
  const out = await f.agent.run(f.paths, f.input)
  assert.match(out.error!, /didn't start the thread within 120 seconds/u)
})

test("Capy keeps its own default model when Model and Effort are empty", async () => {
  const f = fixture()
  const out = await f.agent.run(f.paths, f.input)
  assert.equal(out.ok, true)
  assert.ok(!f.events.includes("GET /models"))
  assert.ok(!Object.hasOwn(f.calls.find((call) => call.route === "/threads")!.body, "model"))
})

test("Capy refuses an effort the model can't take before creating a thread", async () => {
  const f = fixture()
  const out = await f.agent.run(f.paths, { ...f.input, effort: "max" })
  assert.equal(out.ok, false)
  assert.match(out.error!, /Effort: Capy's Particle-1 doesn't support max/u)
  assert.ok(!f.events.includes("POST /threads"))
})

test("Capy refuses a folder its dock hasn't linked, without calling the API", async () => {
  const f = fixture()
  const parent = path.dirname(f.directory)
  const out = await f.agent.run(f.paths, { ...f.input, directory: parent })
  assert.equal(out.ok, false)
  assert.match(out.error!, /hasn't linked/u)
  assert.equal(f.calls.length, 0)
})

test("Capy refuses a dock that isn't connected", async () => {
  const f = fixture(undefined, { dock: () => ({ pid: process.pid, deviceId: "device_1", state: "reconnecting", roots: [] }) })
  const out = await f.agent.run(f.paths, f.input)
  assert.match(out.error!, /dock is reconnecting/u)
})

test("Capy fails and interrupts a thread that asks for input", async () => {
  let interrupted = false
  const f = fixture((call) => {
    if (call.route === "/threads/jam_1/interrupt") {
      interrupted = true
      return { body: {} }
    }
    if (call.route === "/threads/jam_1") return { body: { id: "jam_1", projectId: "project_shop", status: interrupted ? "idle" : "waiting", needsYou: true, ask: interrupted ? null : { key: "k", kind: "conversation", text: "Which branch?", causeKey: null } } }
    return undefined
  })
  const out = await f.agent.run(f.paths, f.input)
  assert.equal(out.ok, false)
  assert.match(out.error!, /waiting for input \(conversation\)/u)
  assert.equal(interrupted, true)
  assert.equal(out.session, "jam_1")
})

test("Capy times out after its deadline and interrupts the thread", async () => {
  let clock = 0
  const f = fixture((call) => {
    if (call.route === "/threads/jam_1") {
      clock += 600_000
      return { body: { id: "jam_1", projectId: "project_shop", status: f.events.includes("POST /threads/jam_1/interrupt") ? "idle" : "working", ask: null } }
    }
    return undefined
  }, { now: () => clock, timeoutMs: 3_600_000 })
  const out = await f.agent.run(f.paths, f.input)
  assert.match(out.error!, /timed out/u)
  assert.ok(f.events.includes("POST /threads/jam_1/interrupt"))
})

test("Capy waits out a 429 as asked and masks the key in errors", async () => {
  let limited = false
  const f = fixture((call) => {
    if (call.route === "/projects" && !limited) {
      limited = true
      return { status: 429, body: { _tag: "capy/RateLimited", retryAfterSeconds: 2 } }
    }
    if (call.route === "/threads" && call.method === "POST") return { status: 403, body: { _tag: "capy/Forbidden", message: "key capy_test_key_value can't reach device" } }
    return undefined
  }, { key: () => process.env.CAPY_API_KEY })
  process.env.CAPY_API_KEY = "capy_test_key_value"
  try {
    const out = await f.agent.run(f.paths, f.input)
    assert.equal(limited, true)
    assert.match(out.error!, /answered 403 to POST \/threads \(capy\/Forbidden/u)
    assert.doesNotMatch(`${out.error} ${out.details}`, /capy_test_key_value/u)
  } finally {
    delete process.env.CAPY_API_KEY
  }
})

test("Capy cancel interrupts only a working thread", async () => {
  const f = fixture((call) => (call.route === "/threads/jam_1" ? { body: { id: "jam_1", projectId: "p", status: "idle" } } : undefined))
  await f.agent.cancel(f.paths, "jam_1")
  assert.ok(!f.events.includes("POST /threads/jam_1/interrupt"))
  await assert.rejects(f.agent.cancel(f.paths, "../x"))
  assert.equal(f.events.filter((event) => event.includes("../x")).length, 0)
})

test("Capy doctor reports the dock and the signed-in API, and needs its key only when installed", async () => {
  const f = fixture()
  const checks = await f.agent.checks(f.paths, ["notion"])
  assert.deepEqual(checks.map((check) => [check.name, check.ok]), [["Capy dock", true], ["Capy API", true], ["Capy MCP", false]])
  assert.deepEqual(f.agent.envNeeds(f.paths).map((need) => need.names), [["CAPY_API_KEY"]])
  const bare = tempHome()
  assert.deepEqual(await f.agent.checks(bare, []), [])
  assert.deepEqual(f.agent.envNeeds(bare), [])
})
