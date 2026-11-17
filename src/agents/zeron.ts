import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import { stdioMcp, type McpClient } from "../shared/mcp.ts"
import type { Check } from "../shared/module.ts"
import { runCommand } from "../shared/process.ts"
import { assertHostedEnvironment, findBinary, hostedPrompt, oneLine, type Agent, type AgentRunInput, type AgentRunOutput } from "./agent.ts"
import { redact } from "./failure.ts"

const Identity = z.looseObject({ localDeviceId: z.string().min(1) })
const Harness = z.looseObject({ id: z.string(), connected: z.boolean(), reasoningLevels: z.array(z.string()), accessModes: z.array(z.string()) })
const Harnesses = z.looseObject({ harnesses: z.array(Harness) })
const Models = z.looseObject({ models: z.array(z.looseObject({ id: z.string(), reasoningLevels: z.array(z.string()) })) })
const ChatId = z.string().regex(/^[\w-]+$/u)
const Created = z.looseObject({ chatId: ChatId, kind: z.string(), deviceId: z.string(), parentChatId: z.string().nullable() })
const Chat = z.looseObject({
  id: ChatId, deviceId: z.string(), cwd: z.string().nullable(), parentChatId: z.string().nullable(), harness: z.string(),
  status: z.string().optional(), sessionStatus: z.string().nullable().optional(), statusStale: z.boolean().optional(), messageCount: z.number().optional(),
})
const Message = z.looseObject({ role: z.string(), status: z.string(), text: z.string().optional() })
const Wait = z.looseObject({
  chatId: ChatId,
  turn: z.looseObject({
    outcome: z.string(),
    status: z.string(),
    statusStale: z.boolean(),
    timedOut: z.boolean(),
    pendingInput: z.unknown().nullable(),
    replies: z.array(Message),
  }),
})

/** These fields also let the scheduler stop a daemon-owned session after its bridge has gone away. */
type HostedInput = AgentRunInput & { signal?: AbortSignal; onSession?: (session: string) => void }
type ClientFactory = typeof stdioMcp

const binary = (paths: Paths) => findBinary("zeron", [path.join(paths.home, ".local/bin")])

/** The bridge must not inherit the parent chat or redirect a local automation to its device. */
function bridgeEnv(env?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...env, NOTION_ACCESS_TOKEN: undefined, ZERON_CHAT_ID: undefined, ZERON_DEVICE_ID: undefined, ZERON_SIDE_CHATS_ONLY: undefined, ZERON_WAITS_ON_BACKGROUND: undefined }
}

/** Explicit harness/model keeps model IDs such as Pi's anthropic/claude-* intact. */
function selection(model: string | null): { harness: string | null; model: string | null } {
  if (!model) return { harness: null, model: null }
  if (/^gpt-[\w.-]+$/u.test(model)) return { harness: "codex", model }
  if (/^claude-[\w.-]+$/u.test(model)) return { harness: "claude-code", model }
  const match = model.match(/^([\w.-]+)\/(\S+)$/u)
  if (match) return { harness: match[1]!, model: match[2]! }
  throw new Error("Model: Zeron needs a gpt-* or claude-* model, or harness/model, such as pi/anthropic/claude-fable-5-2")
}

function assertLocal(chat: z.infer<typeof Chat>, device: string, directory?: string): void {
  if (chat.deviceId !== device || chat.parentChatId !== null) throw new Error("Zeron returned a chat outside the local standalone run")
  if (directory && (!chat.cwd || fs.realpathSync(chat.cwd) !== fs.realpathSync(directory))) throw new Error("Zeron returned a different working folder")
}

async function verifyEngineEnvironment(bin: string, cwd?: string, env?: Record<string, string | undefined>): Promise<void> {
  const status = await runCommand(bin, ["status"], { cwd, env, timeoutMs: 10_000 })
  if (status.code !== 0) throw new Error("Zeron's local engine isn't running; zeron status failed")
  const pid = status.stdout.match(/^Engine:\s+running \(pid (\d+)\)/mu)?.[1]
  if (!pid) throw new Error("Couldn't identify Zeron's local engine process from zeron status")
  assertHostedEnvironment(Number(pid))
}

/** An interrupt is queued; confirm native execution has ended before considering cancellation complete. */
async function stopChat(client: McpClient, session: string, device: string): Promise<void> {
  await client.call("interrupt_chat", { chat: session }, { timeoutMs: 10_000 })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const chat = Chat.parse(await client.call("get_chat", { chat: session }, { timeoutMs: 2_000 }))
    if (chat.id !== session) throw new Error("Zeron returned another chat while confirming interruption")
    assertLocal(chat, device)
    const inactive = chat.sessionStatus === "idle" && !["working", "awaitingInput", "waiting"].includes(chat.status ?? "")
    const unsent = chat.sessionStatus === null && chat.status === "idle" && chat.messageCount === 0
    if (chat.statusStale === false && (inactive || unsent)) return
    if (chat.statusStale === false && (chat.sessionStatus === "errored" || chat.status === "errored")) {
      const result = Wait.parse(await client.call("wait_for_turn", { chat: session, timeout_secs: 1 }, { timeoutMs: 2_000 }))
      if (result.chatId === session && !result.turn.statusStale && !result.turn.timedOut && !result.turn.pendingInput && ["completed", "interrupted", "errored"].includes(result.turn.outcome)) return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("Zeron's interruption is unconfirmed; its chat may still be running")
}

/** Zeron owns execution in its daemon; stdio is a client, not the agent process. */
export function createZeron(factory?: ClientFactory, options: { timeoutMs?: number; now?: () => number } = {}) {
  const connect = factory ?? stdioMcp
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 3_600_000

  return {
    name: "Zeron" as Agent["name"],
    binary,
    settingsError(model: string | null) {
      try {
        selection(model)
        return null
      } catch (error) {
        return (error as Error).message
      }
    },

    async run(paths: Paths, input: HostedInput): Promise<AgentRunOutput> {
      const bin = binary(paths)
      if (!bin) return { ok: false, reply: "", session: null, resume: null, usage: null, error: "Zeron (zeron) isn't installed" }
      let client: McpClient | null = null
      let session: string | null = null
      let reply = ""
      let ok = false
      let failure: string | null = null
      let lastTurn: unknown = null
      let localDevice: string | null = null
      try {
        input.signal?.throwIfAborted()
        const selected = selection(input.model)
        if (!factory) await verifyEngineEnvironment(bin, input.directory, bridgeEnv(input.env))
        input.signal?.throwIfAborted()
        client = await connect(bin, ["mcp"], { cwd: input.directory, env: bridgeEnv(input.env), onStart: input.onStart })
        const request = { timeoutMs: 30_000, signal: input.signal }
        const identity = Identity.parse(await client.call("whoami", {}, request))
        localDevice = identity.localDeviceId
        const catalog = Harnesses.parse(await client.call("list_harnesses", { device: identity.localDeviceId }, request)).harnesses
        const harness = selected.harness
          ? catalog.find((entry) => entry.id === selected.harness && entry.connected)
          : catalog.find((entry) => entry.id === "claude-code" && entry.connected) ?? catalog.find((entry) => entry.id === "codex" && entry.connected) ?? catalog.find((entry) => entry.connected)
        if (!harness) throw new Error(selected.harness ? `Zeron's local ${selected.harness} harness isn't connected` : "Zeron has no connected local harness")
        if (!harness.accessModes.includes("full-access")) throw new Error(`Zeron's ${harness.id} harness cannot run unattended with full-access`)
        if (selected.model || input.effort) {
          const models = Models.parse(await client.call("list_models", { device: identity.localDeviceId, harness: harness.id }, request)).models
          const model = selected.model ? models.find((entry) => entry.id === selected.model) : null
          if (selected.model && !model) throw new Error(`Model: Zeron's ${harness.id} harness doesn't offer ${selected.model}`)
          if (input.effort && !(model?.reasoningLevels ?? harness.reasoningLevels).includes(input.effort)) throw new Error(`Effort: Zeron's ${harness.id}${selected.model ? ` ${selected.model}` : ""} doesn't support ${input.effort}`)
        }
        const created = Created.parse(await client.call("create_chat", {
          kind: "chat", device: identity.localDeviceId, cwd: input.directory, cloud: false,
          harness: harness.id, ...(selected.model ? { model: selected.model } : {}), ...(input.effort ? { reasoning: input.effort } : {}),
          access: "full-access", sandbox: "danger-full-access", title: input.title, wait: false,
        }, request))
        session = created.chatId
        input.onSession?.(session)
        if (created.kind !== "chat" || created.deviceId !== identity.localDeviceId || created.parentChatId !== null) throw new Error("Zeron returned a chat outside the local standalone run")
        const chat = Chat.parse(await client.call("get_chat", { chat: session }, request))
        if (chat.id !== session) throw new Error("Zeron returned another chat's metadata")
        assertLocal(chat, identity.localDeviceId, input.directory)
        if (chat.harness !== harness.id) throw new Error("Zeron returned a different harness")
        input.signal?.throwIfAborted()
        await client.call("send_message", { chat: session, text: hostedPrompt(input), wait: false }, request)
        const deadline = now() + timeoutMs
        while (now() < deadline) {
          input.signal?.throwIfAborted()
          const remaining = deadline - now()
          const seconds = Math.max(1, Math.min(25, Math.ceil(remaining / 1_000)))
          const result = Wait.parse(await client.call("wait_for_turn", { chat: session, timeout_secs: seconds }, { timeoutMs: seconds * 1_000 + 5_000, signal: input.signal }))
          if (result.chatId !== session) throw new Error("Zeron returned another chat's result")
          const turn = result.turn
          lastTurn = turn
          reply = turn.replies.filter((message) => message.role === "assistant" && message.status === "complete").at(-1)?.text ?? ""
          if (turn.statusStale) throw new Error("Zeron's execution status is stale; completion is unverified")
          if (turn.pendingInput || turn.outcome === "awaitingInput" || turn.status === "awaitingInput") throw new Error("Zeron is waiting for input; an unattended run cannot answer it")
          if (turn.timedOut || turn.outcome === "timedOut") continue
          if (turn.outcome !== "completed") throw new Error(`Zeron's turn ${turn.outcome}`)
          if (!reply.trim()) throw new Error("Zeron returned no final reply")
          ok = true
          break
        }
        if (!ok) throw new Error("Zeron timed out before completion")
      } catch (error) {
        failure = redact(oneLine((error as Error).message || String(error)))
      } finally {
        if (!ok && session && client && localDevice) {
          try {
            await stopChat(client, session, localDevice)
          } catch (error) {
            failure = `${failure ?? "Zeron failed"}; couldn't interrupt the chat: ${redact(oneLine((error as Error).message))}`
          }
        }
        await client?.close().catch(() => {})
      }
      return {
        ok, reply, session, resume: null, usage: null,
        error: ok ? null : `Zeron failed: ${failure ?? "unknown error"}`,
        details: ok ? null : redact(JSON.stringify({ error: failure, turn: lastTurn })).slice(-4_000),
      }
    },

    async cancel(paths: Paths, session: string): Promise<void> {
      ChatId.parse(session)
      const bin = binary(paths)
      if (!bin) throw new Error("Zeron (zeron) isn't installed")
      // Stopping an existing session must still work when that engine fails the check for starting new work.
      const client = await connect(bin, ["mcp"], { env: bridgeEnv() })
      try {
        const identity = Identity.parse(await client.call("whoami", {}, { timeoutMs: 10_000 }))
        const chat = Chat.parse(await client.call("get_chat", { chat: session }, { timeoutMs: 10_000 }))
        if (chat.id !== session) throw new Error("Zeron returned another chat's metadata")
        assertLocal(chat, identity.localDeviceId)
        await stopChat(client, session, identity.localDeviceId)
      } finally {
        await client.close()
      }
    },

    envNeeds: (_paths: Paths) => [],

    async checks(paths: Paths, required: string[]): Promise<Check[]> {
      const bin = binary(paths)
      if (!bin) return []
      let client: McpClient | null = null
      try {
        if (!factory) await verifyEngineEnvironment(bin, paths.home, bridgeEnv())
        client = await connect(bin, ["mcp"], { env: bridgeEnv() })
        const identity = Identity.parse(await client.call("whoami", {}, { timeoutMs: 10_000 }))
        const harnesses = Harnesses.parse(await client.call("list_harnesses", { device: identity.localDeviceId }, { timeoutMs: 10_000 })).harnesses.filter((entry) => entry.connected)
        return [
          { ok: true, name: "Zeron engine", detail: `local MCP connected (${identity.localDeviceId})` },
          harnesses.length
            ? { ok: true, name: "Zeron harnesses", detail: `connected locally: ${harnesses.map((entry) => entry.id).join(", ")}` }
            : { ok: false, level: "error", name: "Zeron harnesses", detail: "no connected local harness", fix: "connect a local harness in Zeron" },
          ...(required.length ? [{ ok: false, level: "warning" as const, name: "Zeron harness MCP", detail: `unverified: Zeron's catalog doesn't expose the selected harness's MCP connections (${required.join(", ")})`, fix: "verify the harness's tools inside a Zeron session" }] : []),
        ]
      } catch (error) {
        return [{ ok: false, level: "error", name: "Zeron engine", detail: redact(oneLine((error as Error).message)), fix: "start the local Zeron engine with zeron daemon start" }]
      } finally {
        await client?.close().catch(() => {})
      }
    },
  } satisfies Agent & { cancel(paths: Paths, session: string): Promise<void> }
}

export const zeron = createZeron()
