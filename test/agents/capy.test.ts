import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { hostedPrompt } from "../../src/agents/agent.ts"
import { CAPY_API, capyModel, createCapy, type CapyDeps } from "../../src/agents/capy.ts"
import { tempHome } from "../helpers.ts"

type Call = { method: string; route: string; body: any; auth: string | null }
type Answer = { status?: number; body: unknown; headers?: Record<string, string> }
type Reply = Answer | Error

const msg = (id: string, source: string, text: string) => ({ id, source, text })
const THREAD = { id: "jam_1", projectId: "project_shop", needsYou: false, ask: null, queuedAt: null }

/**
 * A fake Capy API on a fake clock: sleeping advances time, so deadlines are exact. By default a thread works for one
 * poll and then finishes with a two-page transcript.
 */
function fixture(override?: (call: Call, state: { clock: number; polls: number }) => Reply | undefined, deps: Partial<CapyDeps> = {}) {
  const paths = tempHome()
  const directory = path.join(paths.projects, "acme", "shop")
  fs.mkdirSync(directory, { recursive: true })
  fs.mkdirSync(path.join(paths.home, ".capy/bin"), { recursive: true })
  fs.writeFileSync(path.join(paths.home, ".capy/bin/capy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const calls: Call[] = []
  const events: string[] = []
  const sleeps: number[] = []
  const state = { clock: 0, polls: 0 }
  const fake: typeof fetch = (async (url: string, init: RequestInit = {}) => {
    const route = String(url).slice(CAPY_API.length)
    const call = { method: init.method ?? "GET", route, body: init.body ? JSON.parse(String(init.body)) : null, auth: new Headers(init.headers).get("authorization") }
    calls.push(call)
    events.push(`${call.method} ${route.split("?")[0]}`)
    if (route === "/threads/jam_1") state.polls++
    const custom = override?.(call, state)
    if (custom instanceof Error) throw custom
    const reply: Answer = custom ?? ((): Answer => {
      if (route === "/projects") return { body: { items: [
        { id: "project_other", name: "other", repos: [{ repoFullName: "acme/shop", mode: "secondary" }, { repoFullName: "acme/api", mode: "primary" }] },
        { id: "project_shop", name: "shop", repos: [{ repoFullName: "Acme/Shop", mode: "primary" }] },
      ] } }
      if (route === "/models") return { body: { items: [{ id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", reasoningModes: ["low", "high", "max"] }, { id: "particle/particle-1", name: "Particle-1", reasoningModes: ["none"] }], default: { modelId: "particle/particle-1" } } }
      if (route === "/threads" && call.method === "POST") return { body: { ...THREAD, status: "idle" } }
      if (route === "/threads/jam_1") return { body: { ...THREAD, status: state.polls >= 2 ? "idle" : "working" } }
      if (route.startsWith("/threads/jam_1/messages?")) {
        const after = new URLSearchParams(route.split("?")[1]).get("after")
        return after
          ? { body: { items: [msg("m3", "tool", "ls"), msg("m4", "assistant", "Final report")], cursor: null } }
          : { body: { items: [msg("m1", "user", "Work."), msg("m2", "assistant", "intermediate")], cursor: "01PAGE" } }
      }
      if (route === "/threads/jam_1/interrupt") return { body: { id: "01RECEIPT", deduped: false } }
      throw new Error(`unexpected ${call.method} ${route}`)
    })()
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers })
  }) as typeof fetch
  const agent = createCapy({
    fetch: fake, key: () => "capy_test_key_value", pollMs: 5_000,
    now: () => state.clock,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted()
      sleeps.push(ms)
      state.clock += ms
    },
    dock: () => ({ pid: process.pid, deviceId: "device_1", state: "connected", roots: [path.join(paths.projects, "other"), directory] }),
    origin: async (folder) => (folder === directory ? "acme/shop" : null),
    verifyDock: () => {},
    ...deps,
  })
  const input = { directory, prompt: "Work.", model: null, effort: null, title: "AUT-1 Test" }
  return { paths, directory, agent, calls, events, sleeps, state, input }
}

const count = (events: string[], event: string) => events.filter((entry) => entry === event).length

test("Capy maps ntncode models to its IDs and rejects others in settings", () => {
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
  assert.equal(count(f.events, "POST /threads/jam_1/interrupt"), 0)
})

test("Capy keeps its own default model when Model and Effort are empty", async () => {
  const f = fixture()
  const out = await f.agent.run(f.paths, f.input)
  assert.equal(out.ok, true)
  assert.equal(count(f.events, "GET /models"), 0)
  assert.ok(!Object.hasOwn(f.calls.find((call) => call.route === "/threads")!.body, "model"))
})

test("Capy waits for a new thread that reads idle before the dock picks it up", async () => {
  const states = ["idle", "idle", "working", "idle"]
  const f = fixture((call, state) => {
    if (call.route === "/threads/jam_1") return { body: { ...THREAD, status: states[Math.min(state.polls - 1, 3)] } }
    if (call.route.startsWith("/threads/jam_1/messages?") && state.polls < 3) return { body: { items: [msg("m1", "user", "Work.")], cursor: null } }
    return undefined
  })
  const out = await f.agent.run(f.paths, f.input)
  assert.deepEqual([out.ok, out.reply, f.state.polls], [true, "Final report", 4])
})

test("Capy never reports an unsettled transcript: an unchanged cursor waits for the final message", async () => {
  let settled = false
  const f = fixture((call, state) => {
    if (call.route === "/threads/jam_1") return { body: { ...THREAD, status: "idle" } }
    if (!call.route.startsWith("/threads/jam_1/messages?")) return undefined
    if (state.polls >= 3) settled = true
    const after = new URLSearchParams(call.route.split("?")[1]).get("after")
    if (!after) return { body: { items: [msg("m1", "user", "Work."), msg("m2", "assistant", "Let me look first")], cursor: "01PAGE" } }
    return settled ? { body: { items: [msg("m3", "assistant", "Final report")], cursor: null } } : { body: { items: [], cursor: "01PAGE" } }
  })
  const out = await f.agent.run(f.paths, f.input)
  assert.deepEqual([out.ok, out.reply], [true, "Final report"])
})

test("Capy fails a thread its dock never starts, then interrupts it once the dock picks its prompt up late", async () => {
  // Capy hides a queued opening prompt from the transcript and runs it even after an interrupt, so stop waits for pickup.
  const f = fixture((call, state) => {
    const late = state.clock > 125_000
    const interrupted = f.events.includes("POST /threads/jam_1/interrupt")
    if (call.route === "/threads/jam_1") return { body: { ...THREAD, status: !late ? "idle" : interrupted ? "idle" : "working", queuedAt: late ? null : "2026-11-17T20:00:00Z" } }
    if (call.route.startsWith("/threads/jam_1/messages?")) return { body: { items: late ? [msg("m1", "user", "Work."), msg("m2", "assistant", "Interrupted.")] : [], cursor: null } }
    return undefined
  })
  const out = await f.agent.run(f.paths, f.input)
  assert.match(out.error!, /didn't start the thread within 120 seconds/u)
  assert.doesNotMatch(out.error!, /couldn't stop/u)
  assert.equal(count(f.events, "POST /threads/jam_1/interrupt"), 1)
  assert.equal(f.events.filter((event) => event.includes("/cancel")).length, 0, "a hidden prompt has no ID to cancel")
})

test("Capy cancel reports a queued thread its dock never picks up as unconfirmed", async () => {
  const f = fixture((call) => {
    if (call.route === "/threads/jam_1") return { body: { ...THREAD, status: "idle", queuedAt: "2026-11-17T20:00:00Z" } }
    if (call.route.startsWith("/threads/jam_1/messages?")) return { body: { items: [], cursor: null } }
    return undefined
  })
  await assert.rejects(f.agent.cancel!(f.paths, "jam_1"), /stop is unconfirmed/u)
  assert.equal(f.state.clock, 30_000)
})

test("Capy cancel cancels a visible prompt that hasn't started and accepts a repeat stop", async () => {
  const f = fixture((call) => {
    const cancelled = f.events.includes("POST /threads/jam_1/messages/m3/cancel")
    if (call.route === "/threads/jam_1") return { body: { ...THREAD, status: "idle" } }
    if (call.route.startsWith("/threads/jam_1/messages?")) return { body: { items: [msg("m1", "user", "Work."), msg("m2", "assistant", "Done."), ...(cancelled ? [] : [msg("m3", "user", "More.")])], cursor: null } }
    if (call.route === "/threads/jam_1/messages/m3/cancel") return { body: { outcome: "cancelled" } }
    return undefined
  })
  await f.agent.cancel!(f.paths, "jam_1")
  await f.agent.cancel!(f.paths, "jam_1")
  assert.equal(count(f.events, "POST /threads/jam_1/messages/m3/cancel"), 1)
  assert.equal(count(f.events, "POST /threads/jam_1/interrupt"), 0)
})

test("Capy refuses an effort the model can't take before creating a thread", async () => {
  const f = fixture()
  const out = await f.agent.run(f.paths, { ...f.input, effort: "max" })
  assert.equal(out.ok, false)
  assert.match(out.error!, /Effort: Capy's Particle-1 doesn't support max/u)
  assert.equal(count(f.events, "POST /threads"), 0)
})

test("Capy refuses a folder its dock hasn't linked, without calling the API", async () => {
  const f = fixture()
  const out = await f.agent.run(f.paths, { ...f.input, directory: path.dirname(f.directory) })
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
      return { body: { id: "01RECEIPT", deduped: false } }
    }
    if (call.route === "/threads/jam_1") return { body: { ...THREAD, status: interrupted ? "idle" : "working", needsYou: !interrupted, ask: interrupted ? null : { key: "k", kind: "conversation", text: "Which branch?", causeKey: null } } }
    if (call.route.startsWith("/threads/jam_1/messages?")) return { body: { items: [msg("m1", "user", "Work."), msg("m2", "assistant", "Which branch?")], cursor: null } }
    return undefined
  })
  const out = await f.agent.run(f.paths, f.input)
  assert.match(out.error!, /waiting for input \(conversation\)/u)
  assert.deepEqual([interrupted, out.session], [true, "jam_1"])
})

test("Capy times out at its deadline and interrupts the thread", async () => {
  let interrupted = false
  const f = fixture((call) => {
    if (call.route === "/threads/jam_1/interrupt") {
      interrupted = true
      return { body: { id: "01RECEIPT", deduped: false } }
    }
    if (call.route === "/threads/jam_1") return { body: { ...THREAD, status: interrupted ? "idle" : "working" } }
    if (call.route.startsWith("/threads/jam_1/messages?")) return { body: { items: [msg("m1", "user", "Work."), msg("m2", "assistant", "partial")], cursor: null } }
    return undefined
  })
  const out = await f.agent.run(f.paths, f.input)
  assert.match(out.error!, /timed out/u)
  assert.ok(f.state.clock >= 3_600_000 && f.state.clock < 3_700_000)
  assert.equal(interrupted, true)
})

test("Capy rides out transient API failures during a run without interrupting it", async () => {
  let failures = 0
  const f = fixture((call) => {
    // The first status read fails twice, once on the network and once with a 502, before it answers.
    if (call.route === "/threads/jam_1" && failures < 2) {
      failures++
      return failures === 1 ? new TypeError("fetch failed") : { status: 502, body: { _tag: "BadGateway" } }
    }
    return undefined
  })
  const out = await f.agent.run(f.paths, f.input)
  assert.deepEqual([out.ok, out.reply, failures], [true, "Final report", 2])
  assert.equal(count(f.events, "POST /threads/jam_1/interrupt"), 0)
})

test("Capy recovers a thread whose creation answer was lost, records it, and stops it", async () => {
  let creates = 0
  const f = fixture((call) => {
    if (call.route === "/threads" && call.method === "POST") {
      creates++
      // The first request reaches Capy, but no answer comes back before the deadline.
      return creates <= 7 ? new TypeError("socket hang up") : { body: { ...THREAD, status: "working" } }
    }
    if (call.route === "/threads/jam_1") return { body: { ...THREAD, status: f.events.includes("POST /threads/jam_1/interrupt") ? "idle" : "working" } }
    if (call.route.startsWith("/threads/jam_1/messages?")) return { body: { items: [msg("m1", "user", "Work."), msg("m2", "assistant", "stopped")], cursor: null } }
    return undefined
  })
  const sessions: string[] = []
  const out = await f.agent.run(f.paths, { ...f.input, onSession: (session) => sessions.push(session) })
  assert.match(out.error!, /didn't answer POST \/threads/u)
  assert.deepEqual([out.session, sessions], ["jam_1", ["jam_1"]])
  const ids = new Set(f.calls.filter((call) => call.route === "/threads").map((call) => call.body.requestId))
  assert.equal(ids.size, 1, "every attempt replays the same requestId, so Capy never starts a second thread")
  assert.equal(count(f.events, "POST /threads/jam_1/interrupt"), 1)
})

test("Capy recovers and stops a thread when the scheduler aborts during creation", async () => {
  const controller = new AbortController()
  const f = fixture((call) => {
    if (call.route === "/threads" && call.method === "POST" && !controller.signal.aborted) {
      controller.abort(new Error("scheduler stopping"))
      return new DOMException("aborted", "AbortError")
    }
    if (call.route === "/threads" && call.method === "POST") return { body: { ...THREAD, status: "idle", queuedAt: "2026-11-17T20:00:00Z" } }
    if (call.route === "/threads/jam_1") return { body: { ...THREAD, status: "idle", queuedAt: f.events.includes("POST /threads/jam_1/messages/m1/cancel") ? null : "2026-11-17T20:00:00Z" } }
    if (call.route.startsWith("/threads/jam_1/messages?")) return { body: { items: [msg("m1", "user", "Work.")], cursor: null } }
    if (call.route === "/threads/jam_1/messages/m1/cancel") return { body: { outcome: "cancelled" } }
    return undefined
  })
  const out = await f.agent.run(f.paths, { ...f.input, signal: controller.signal })
  assert.equal(out.ok, false)
  assert.equal(out.session, "jam_1")
  assert.equal(count(f.events, "POST /threads/jam_1/messages/m1/cancel"), 1)
})

test("Capy waits out a 429 for as long as Capy asks, and masks the key in errors", async () => {
  let limited = false
  const f = fixture((call) => {
    if (call.route === "/projects" && !limited) {
      limited = true
      return { status: 429, body: { _tag: "capy/RateLimited", retryAfterSeconds: 7 } }
    }
    if (call.route === "/threads" && call.method === "POST") return { status: 403, body: { _tag: "capy/Forbidden", message: "key capy_test_key_value can't reach device" } }
    return undefined
  }, { key: () => process.env.CAPY_API_KEY })
  process.env.CAPY_API_KEY = "capy_test_key_value"
  try {
    const out = await f.agent.run(f.paths, f.input)
    assert.deepEqual(f.sleeps, [7_000])
    assert.match(out.error!, /answered 403 to POST \/threads \(capy\/Forbidden/u)
    assert.doesNotMatch(`${out.error} ${out.details}`, /capy_test_key_value/u)
    assert.equal(out.session, null, "a refused creation started nothing, so there is nothing to recover")
    assert.equal(count(f.events, "POST /threads"), 1)
  } finally {
    delete process.env.CAPY_API_KEY
  }
})

test("Capy cancel interrupts a working thread until it stops", async () => {
  let interrupts = 0
  const f = fixture((call) => {
    if (call.route === "/threads/jam_1/interrupt") {
      interrupts++
      return { body: { id: "01RECEIPT", deduped: false } }
    }
    if (call.route === "/threads/jam_1") return { body: { ...THREAD, status: interrupts ? "idle" : "working" } }
    if (call.route.startsWith("/threads/jam_1/messages?")) return { body: { items: [msg("m1", "user", "Work."), msg("m2", "assistant", "stopped")], cursor: null } }
    return undefined
  })
  await f.agent.cancel(f.paths, "jam_1")
  assert.equal(interrupts, 1)
})

test("Capy cancel leaves a finished thread alone and refuses an invalid ID", async () => {
  const f = fixture((call) => (call.route === "/threads/jam_1" ? { body: { ...THREAD, status: "idle" } } : undefined))
  await f.agent.cancel(f.paths, "jam_1")
  assert.equal(count(f.events, "POST /threads/jam_1/interrupt"), 0)
  assert.equal(f.events.filter((event) => event.includes("/cancel")).length, 0)
  await assert.rejects(f.agent.cancel(f.paths, "../x"))
  assert.ok(!f.events.some((event) => event.includes("../x")))
})

test("Capy cancel throws while the thread keeps working, so the automation stays blocked", async () => {
  const f = fixture((call) => {
    if (call.route === "/threads/jam_1") return { body: { ...THREAD, status: "working" } }
    return undefined
  })
  await assert.rejects(f.agent.cancel(f.paths, "jam_1"), /unconfirmed/u)
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

test("Capy doctor reports a dock carrying the scheduler token as one failure", async () => {
  const f = fixture(undefined, { verifyDock: () => { throw new Error("The local app engine has NOTION_ACCESS_TOKEN in its environment") } })
  const docks = (await f.agent.checks(f.paths, [])).filter((check) => check.name === "Capy dock")
  assert.deepEqual(docks.map((check) => check.ok), [false])
  assert.match(docks[0]!.detail, /NOTION_ACCESS_TOKEN/u)
})
