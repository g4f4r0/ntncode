import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import type { Check } from "../shared/module.ts"
import { isAlive, runCommand } from "../shared/process.ts"
import { assertHostedEnvironment, hostedPrompt, oneLine, type Agent, type AgentRunInput, type AgentRunOutput, type Effort } from "./agent.ts"
import { redact } from "./failure.ts"

export const CAPY_API = "https://api.capy.ai/api/v1"
const KEY = "CAPY_API_KEY"

const ThreadId = z.string().regex(/^[\w-]+$/u)
const Dock = z.looseObject({ pid: z.number().int(), deviceId: z.string().min(1), state: z.string(), roots: z.array(z.string()) })
const Repo = z.looseObject({ repoFullName: z.string(), mode: z.string().optional() })
const Projects = z.looseObject({ items: z.array(z.looseObject({ id: z.string(), name: z.string(), repos: z.array(Repo) })) })
const Models = z.looseObject({
  items: z.array(z.looseObject({ id: z.string(), name: z.string(), reasoningModes: z.array(z.string()) })),
  default: z.looseObject({ modelId: z.string() }).nullish(),
})
const Ask = z.looseObject({ kind: z.string(), text: z.string().nullable() })
const Thread = z.looseObject({ id: ThreadId, projectId: z.string().nullable(), status: z.string(), needsYou: z.boolean().optional(), ask: Ask.nullish() })
const Page = z.looseObject({ items: z.array(z.looseObject({ source: z.string(), text: z.string() })), cursor: z.string().nullable() })
type Thread = z.infer<typeof Thread>
type Dock = z.infer<typeof Dock>

export interface CapyDeps {
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** The dock's status; by default ~/.capy/dock/status.json. */
  dock?: (paths: Paths) => Dock
  /** The folder's origin repository as owner/repo; by default from git. */
  origin?: (directory: string) => Promise<string | null>
  /** Verifies the dock's process holds no scheduler credentials; by default through /proc. */
  verifyDock?: (pid: number) => void
  key?: () => string | undefined
  pollMs?: number
  timeoutMs?: number
  /** How long a new thread may stay idle, unstarted, before the run fails. */
  pickupMs?: number
}

const binary = (paths: Paths) => {
  const file = path.join(paths.home, ".capy/bin/capy")
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return file
  } catch {
    return null
  }
}

function readDock(paths: Paths): Dock {
  const file = path.join(paths.home, ".capy/dock/status.json")
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    throw new Error("Capy's dock has no status; pair this machine with capy dock")
  }
  return Dock.parse(raw)
}

async function gitOrigin(directory: string): Promise<string | null> {
  const result = await runCommand("git", ["-C", directory, "remote", "get-url", "origin"], { timeoutMs: 10_000 })
  if (result.code !== 0) return null
  return /[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/u.exec(result.stdout.trim())?.[1] ?? null
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener("abort", () => {
    clearTimeout(timer)
    reject(signal.reason)
  }, { once: true })
})

/**
 * A Model property value as a Capy model ID: Notion Code's claude-* and gpt-* IDs gain their provider, and a
 * provider/model ID, such as claude-code/claude-opus-5-5 or google/gemini-4-argon, passes through as it is.
 */
export function capyModel(model: string | null): string | null {
  if (!model) return null
  if (/^claude-[\w.-]+$/u.test(model)) return `anthropic/${model}`
  if (/^gpt-[\w.-]+$/u.test(model)) return `openai/${model}`
  if (/^[\w.-]+\/[\w.-]+$/u.test(model)) return model
  throw new Error("Model: Capy needs a Claude or GPT model, or a Capy model ID such as google/gemini-4-argon")
}

/** The linked dock folder that is exactly this run's folder, so Capy never works in a parent or a neighbour. */
function linkedRoot(dock: Dock, directory: string): string {
  const exact = fs.realpathSync(directory)
  const root = dock.roots.find((entry) => {
    try {
      return fs.realpathSync(entry) === exact
    } catch {
      return false
    }
  })
  if (!root) throw new Error(`Capy's dock hasn't linked ${directory}; link that folder in Capy, or set the automation's Repository to a linked clone`)
  return root
}

/** The Capy project for a repository: the one where it is primary, else the only one that holds it. */
function projectFor(projects: z.infer<typeof Projects>["items"], repository: string): string {
  const holds = projects.filter((project) => project.repos.some((repo) => repo.repoFullName.toLowerCase() === repository.toLowerCase()))
  const primary = holds.filter((project) => project.repos.some((repo) => repo.repoFullName.toLowerCase() === repository.toLowerCase() && repo.mode === "primary"))
  const pick = primary.length === 1 ? primary : holds
  if (pick.length === 1) return pick[0]!.id
  if (!pick.length) throw new Error(`Capy has no project for ${repository}; add the repository to a Capy project`)
  throw new Error(`Capy has several projects for ${repository} (${pick.map((project) => project.name).join(", ")}); keep it primary in one`)
}

export function createCapy(deps: CapyDeps = {}) {
  const request = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const dockOf = deps.dock ?? readDock
  const originOf = deps.origin ?? gitOrigin
  const verifyDock = deps.verifyDock ?? assertHostedEnvironment
  const keyOf = deps.key ?? (() => process.env[KEY])
  const pollMs = deps.pollMs ?? 5_000
  const timeoutMs = deps.timeoutMs ?? 3_600_000
  const pickupMs = deps.pickupMs ?? 120_000

  /** One API call. A 429 waits as long as Capy asks, within the deadline; any other failure throws Capy's own reason. */
  async function api<T>(schema: z.ZodType<T>, method: string, route: string, options: { body?: unknown; signal?: AbortSignal; deadline?: number } = {}): Promise<T> {
    const key = keyOf()
    if (!key) throw new Error(`${KEY} isn't in the scheduler's environment`)
    const deadline = options.deadline ?? now() + 60_000
    for (;;) {
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
      const response = await request(`${CAPY_API}${route}`, {
        method, redirect: "error", signal,
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
      const text = await response.text()
      let body: unknown = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {}
      if (response.status === 429) {
        const seconds = Number((body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds ?? response.headers.get("retry-after") ?? 5)
        const wait = Math.max(1, Number.isFinite(seconds) ? seconds : 5) * 1_000
        if (now() + wait > deadline) throw new Error("Capy's API is rate limiting this key")
        await sleep(wait, options.signal)
        continue
      }
      if (!response.ok) {
        const reason = body && typeof body === "object" ? [(body as Record<string, unknown>)._tag, (body as Record<string, unknown>).message].filter((part) => typeof part === "string").join(": ") : ""
        throw new Error(`Capy's API answered ${response.status} to ${method} ${route.split("?")[0]}${reason ? ` (${reason})` : ""}`)
      }
      return schema.parse(body)
    }
  }

  const getThread = (id: string, signal?: AbortSignal, deadline?: number) => api(Thread, "GET", `/threads/${id}`, { signal, deadline })

  /** The last assistant message: the transcript reads oldest first, so page forward until the end. */
  async function finalReply(id: string, signal?: AbortSignal): Promise<string> {
    let reply = ""
    let after: string | null = null
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ limit: "100", ...(after ? { after } : {}) })
      const result = await api(Page, "GET", `/threads/${id}/messages?${query}`, { signal })
      reply = result.items.filter((item) => item.source === "assistant" && item.text.trim()).at(-1)?.text ?? reply
      if (!result.cursor || result.cursor === after) return reply
      after = result.cursor
    }
    return reply
  }

  /** An interrupt is a request; confirm the thread has stopped working before calling the session stopped. */
  async function stop(id: string): Promise<void> {
    await api(z.unknown(), "POST", `/threads/${id}/interrupt`)
    const deadline = now() + 30_000
    while (now() < deadline) {
      const thread = await getThread(id)
      if (thread.id !== id) throw new Error("Capy returned another thread while confirming the interrupt")
      if (thread.status !== "working") return
      await sleep(Math.min(pollMs, 2_000))
    }
    throw new Error("Capy's interrupt is unconfirmed; its thread may still be working")
  }

  async function validate(model: string | null, effort: Effort | null, signal?: AbortSignal): Promise<{ modelId: string; reasoningMode?: Effort } | null> {
    const id = capyModel(model)
    if (!id && !effort) return null
    const catalog = await api(Models, "GET", "/models", { signal })
    const chosen = id ?? catalog.default?.modelId
    const entry = catalog.items.find((item) => item.id === chosen)
    // Device harness models (claude-code/…) aren't in the catalog; Capy rejects a bad one at creation without fallback.
    if (id && !entry && !id.includes("claude-code/") && !id.includes("codex/")) throw new Error(`Model: Capy doesn't offer ${id}`)
    if (effort && entry && !entry.reasoningModes.includes(effort)) throw new Error(`Effort: Capy's ${entry.name} doesn't support ${effort}`)
    if (!chosen) throw new Error("Effort: Capy has no default model to apply it to; set Model too")
    return { modelId: chosen, ...(effort ? { reasoningMode: effort } : {}) }
  }

  return {
    name: "Capy" as Agent["name"],
    binary,
    settingsError(model: string | null, _effort?: Effort | null) {
      try {
        capyModel(model)
        return null
      } catch (error) {
        return (error as Error).message
      }
    },

    async run(paths: Paths, input: AgentRunInput): Promise<AgentRunOutput> {
      let session: string | null = null
      let reply = ""
      let ok = false
      let failure: string | null = null
      let last: Thread | null = null
      try {
        input.signal?.throwIfAborted()
        if (!binary(paths)) throw new Error("Capy's dock (~/.capy/bin/capy) isn't installed")
        const dock = dockOf(paths)
        if (dock.state !== "connected") throw new Error(`Capy's dock is ${dock.state}, not connected`)
        if (!isAlive(dock.pid)) throw new Error("Capy's dock isn't running; start capy-dock.service")
        verifyDock(dock.pid)
        const root = linkedRoot(dock, input.directory)
        const repository = await originOf(root)
        if (!repository) throw new Error(`${input.directory} has no GitHub origin, and Capy needs one to choose its project`)
        const projectId = projectFor((await api(Projects, "GET", "/projects", { signal: input.signal })).items, repository)
        const model = await validate(input.model, input.effort, input.signal)
        input.signal?.throwIfAborted()
        const thread = await api(Thread, "POST", "/threads", {
          signal: input.signal,
          body: {
            // Capy dedupes creation by requestId, so a retried request never starts a second thread.
            requestId: `ntncode-${randomUUID()}`,
            projectId, title: input.title, message: hostedPrompt(input),
            device: { deviceId: dock.deviceId, workspace: { kind: "linked", root } },
            ...(model ? { model } : {}),
          },
        })
        session = thread.id
        input.onSession?.(session)
        if (thread.projectId !== projectId) throw new Error("Capy returned a thread in another project")
        const deadline = now() + timeoutMs
        // A new thread reads idle until the dock picks up its message, so idle counts as finished only after it started.
        const pickup = now() + pickupMs
        let started = false
        while (now() < deadline) {
          input.signal?.throwIfAborted()
          last = await getThread(session, input.signal, deadline)
          if (last.id !== session) throw new Error("Capy returned another thread")
          if (last.ask) throw new Error(`Capy is waiting for input (${last.ask.kind}); an unattended run cannot answer it`)
          if (last.status === "waiting" && last.needsYou) throw new Error("Capy is waiting for input; an unattended run cannot answer it")
          if (last.status === "failed") throw new Error("Capy's thread failed")
          if (last.status === "archived") throw new Error("Capy's thread was archived before it finished")
          if (last.status === "working") started = true
          if (last.status === "idle") {
            reply = await finalReply(session, input.signal)
            if (reply.trim()) {
              ok = true
              break
            }
            if (started) throw new Error("Capy's thread went idle with no final reply")
            if (now() >= pickup) throw new Error(`Capy's dock didn't start the thread within ${Math.round(pickupMs / 1_000)} seconds`)
          }
          await sleep(pollMs, input.signal)
        }
        if (!ok) throw new Error("Capy timed out before completion")
      } catch (error) {
        failure = redact(oneLine((error as Error).message || String(error)))
      }
      if (!ok && session) {
        try {
          await stop(session)
        } catch (error) {
          failure = `${failure ?? "Capy failed"}; couldn't interrupt the thread: ${redact(oneLine((error as Error).message))}`
        }
      }
      return {
        ok, reply, session, resume: null, usage: null,
        error: ok ? null : `Capy failed: ${failure ?? "unknown error"}`,
        details: ok ? null : redact(JSON.stringify({ error: failure, thread: last })).slice(-4_000),
      }
    },

    async cancel(_paths: Paths, session: string): Promise<void> {
      ThreadId.parse(session)
      const thread = await getThread(session)
      if (thread.id !== session) throw new Error("Capy returned another thread")
      if (thread.status === "working") await stop(session)
    },

    envNeeds: (paths: Paths) => binary(paths) ? [{ names: [KEY], why: "Capy's API key, from the Capy app's Settings → API" }] : [],

    async checks(paths: Paths, required: string[]): Promise<Check[]> {
      if (!binary(paths)) return []
      const checks: Check[] = []
      try {
        const dock = dockOf(paths)
        const running = dock.state === "connected" && isAlive(dock.pid)
        checks.push(running
          ? { ok: true, name: "Capy dock", detail: `connected as ${dock.deviceId}, ${dock.roots.length} linked folders` }
          : { ok: false, level: "error", name: "Capy dock", detail: `${dock.state}${isAlive(dock.pid) ? "" : ", not running"}`, fix: "systemctl --user restart capy-dock.service, then capy dock doctor" })
        if (running) verifyDock(dock.pid)
      } catch (error) {
        checks.push({ ok: false, level: "error", name: "Capy dock", detail: redact(oneLine((error as Error).message)), fix: "capy dock doctor" })
      }
      if (keyOf()) {
        try {
          const projects = await api(Projects, "GET", "/projects")
          checks.push({ ok: true, name: "Capy API", detail: `signed in; ${projects.items.length} projects` })
        } catch (error) {
          checks.push({ ok: false, level: "error", name: "Capy API", detail: redact(oneLine((error as Error).message)), fix: `create a key in Capy under Settings → API and set ${KEY} in ~/.config/notion-code/agents.env` })
        }
      }
      if (required.length) checks.push({ ok: false, level: "warning", name: "Capy MCP", detail: `unverified: Capy's API doesn't expose its agents' MCP connections (${required.join(", ")})`, fix: "verify the tools inside a Capy thread" })
      return checks
    },
  } satisfies Agent & { cancel(paths: Paths, session: string): Promise<void> }
}

export const capy = createCapy()
