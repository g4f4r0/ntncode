import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import type { McpClient } from "../shared/mcp.ts"
import type { Check } from "../shared/module.ts"
import { runCommand } from "../shared/process.ts"
import { hostedPrompt, oneLine, type Agent, type AgentRunInput } from "./agent.ts"
import { connectT3, t3Binary, t3Origin } from "./t3-connection.ts"

const Project = z.looseObject({ id: z.string(), workspaceRoot: z.string() })
const Projects = z.object({ projects: z.array(Project), nextCursor: z.number().nullable() })
const Capabilities = z.looseObject({ providers: z.array(z.looseObject({
  providerInstanceId: z.string(), canRunChildTask: z.boolean(), constraints: z.array(z.string()),
  models: z.array(z.looseObject({ id: z.string(), options: z.array(z.looseObject({ id: z.string(), values: z.array(z.union([z.string(), z.boolean()])) })).nullish() })),
})) })
const Wait = z.looseObject({ threadId: z.string(), runId: z.string().nullable(), status: z.string(), timedOut: z.boolean(), resultRun: z.looseObject({ runId: z.string(), status: z.string() }).nullish() })
const Item = z.looseObject({ type: z.string(), itemId: z.string(), runId: z.string().nullable().optional(), position: z.number(), text: z.string().nullish(), textTruncated: z.boolean().optional(), nextTextOffset: z.number().nullable().optional() })
const Read = z.looseObject({ thread: z.looseObject({ pendingRequestCount: z.number().optional() }), recentRuns: z.array(z.looseObject({ runId: z.string().optional(), id: z.string().optional(), status: z.string() })).optional(), items: z.array(Item), nextPosition: z.number().nullable(), hasMore: z.boolean() })
const successful = new Set(["completed", "succeeded"])
const active = new Set(["running", "queued", "starting", "interrupt_requested", "stopping"])
const settingsError: Agent["settingsError"] = (model, effort) => effort && !model ? "Effort: T3 Code sets effort through the model, so set Model too" : null

async function projectFor(client: McpClient, directory: string): Promise<string> {
  const exact = fs.realpathSync(directory)
  if (!fs.statSync(exact).isDirectory()) throw new Error("Directory: T3 Code needs an existing folder")
  let cursor: number | undefined
  const seen = new Set<number>()
  do {
    const page = Projects.parse(await client.call("t3_project_list", { limit: 100, ...(cursor === undefined ? {} : { cursor }) }))
    for (const project of page.projects) {
      try { if (fs.realpathSync(project.workspaceRoot) === exact) return project.id } catch {}
    }
    if (page.nextCursor === null) break
    if (seen.has(page.nextCursor)) throw new Error("T3 Code project pagination didn't advance")
    seen.add(page.nextCursor)
    cursor = page.nextCursor
  } while (true)
  // Register precisely this folder. Never let T3 choose its nearest parent or create a workspace.
  const project = Project.parse(await client.call("t3_project_create", { title: path.basename(exact), workspaceRoot: exact, createWorkspaceRootIfMissing: false }))
  if (fs.realpathSync(project.workspaceRoot) !== exact) throw new Error("T3 Code registered a different workspace folder")
  return project.id
}

async function selection(client: McpClient, input: AgentRunInput): Promise<Record<string, unknown> | undefined> {
  if (!input.model) return undefined
  const slash = input.model.indexOf("/")
  const instance = slash < 0 ? null : input.model.slice(0, slash)
  const model = slash < 0 ? input.model : input.model.slice(slash + 1)
  const capabilities = Capabilities.parse(await client.call("orchestrator_capabilities", { search: model }))
  const matches = capabilities.providers.filter((provider) => provider.canRunChildTask && !provider.constraints.length && (!instance || provider.providerInstanceId === instance)).flatMap((provider) => provider.models.filter((entry) => entry.id === model).map((entry) => ({ provider, entry })))
  if (matches.length !== 1) throw new Error(matches.length ? "Model: T3 Code has multiple providers for this model; use providerInstanceId/model" : `Model: T3 Code has no enabled provider for ${input.model}`)
  const { provider, entry } = matches[0]!
  const options: { id: string; value: string }[] = []
  if (input.effort) {
    const option = entry.options?.find((value) => ["reasoningEffort", "effort"].includes(value.id) && value.values.includes(input.effort!))
    if (!option) throw new Error(`Effort: T3 Code model ${input.model} doesn't support ${input.effort}`)
    options.push({ id: option.id, value: input.effort })
  }
  return { instanceId: provider.providerInstanceId, model, ...(options.length ? { options } : {}) }
}

async function finalReply(client: McpClient, threadId: string, runId: string, signal?: AbortSignal): Promise<string> {
  let afterPosition: number | undefined
  let last: z.infer<typeof Item> | undefined
  const seen = new Set<number>()
  do {
    const page = Read.parse(await client.call("t3_thread_read", { threadId, view: "messages", limit: 100, maxCharsPerItem: 50_000, ...(afterPosition === undefined ? {} : { afterPosition }) }, { signal }))
    if (page.thread.pendingRequestCount) throw new Error("T3 Code is waiting for user input")
    for (const item of page.items) if (item.runId === runId && item.type === "assistant_message" && (!last || item.position >= last.position)) last = item
    if (!page.hasMore) break
    if (page.nextPosition === null || seen.has(page.nextPosition)) throw new Error("T3 Code message pagination didn't advance")
    seen.add(page.nextPosition)
    afterPosition = page.nextPosition
  } while (true)
  if (!last) throw new Error("T3 Code completed without a final assistant reply for this run")
  let reply = last.text ?? ""
  let part = last
  const offsets = new Set<number>()
  while (part.textTruncated) {
    const offset = part.nextTextOffset
    if (offset == null || offsets.has(offset)) throw new Error("T3 Code reply pagination didn't advance")
    offsets.add(offset)
    const page = Read.parse(await client.call("t3_thread_read", { threadId, itemId: last.itemId, textOffset: offset, maxCharsPerItem: 50_000 }, { signal }))
    const chunk = page.items.find((item) => item.itemId === last!.itemId && item.runId === runId)
    if (!chunk) throw new Error("T3 Code omitted part of the final reply")
    reply += chunk.text ?? ""
    part = chunk
  }
  if (!reply.trim()) throw new Error("T3 Code completed with an empty final reply")
  return reply
}

/** Stop the run and its delegated work, then verify the engine has settled. */
async function stop(client: McpClient, threadId: string): Promise<void> {
  z.looseObject({ status: z.string() }).parse(await client.call("t3_thread_interrupt", { threadId, stop: true, reason: "Automation stopped", clientRequestId: randomUUID() }, { timeoutMs: 15_000 }))
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const value = Wait.parse(await client.call("t3_thread_wait", { threadId, timeoutMs: 5_000, untilDelegatedWorkSettled: true }, { timeoutMs: 10_000 }))
    if (value.threadId !== threadId) throw new Error("T3 Code returned another thread while confirming interruption")
    if (!value.timedOut && !active.has(value.status) && ["idle", "interrupted", "cancelled", "failed", "rolled_back", "no_active_run", ...successful].includes(value.status)) return
    if (!value.timedOut && !active.has(value.status)) throw new Error(`T3 Code cancellation is unconfirmed (${value.status})`)
  }
  throw new Error("T3 Code cancellation wasn't confirmed within 45 seconds")
}

export function createT3Code(connect: (paths: Paths) => Promise<McpClient> = connectT3): Agent {
  return {
    name: "T3 Code", binary: t3Binary, settingsError, envNeeds: () => [],
    async run(paths, input) {
      let client: McpClient | null = null
      let session: string | null = null
      let reply = ""
      let error: string | null = null
      let finished = false
      try {
        const setting = settingsError(input.model, input.effort)
        if (setting) throw new Error(setting)
        if (input.signal?.aborted) throw new Error("Run cancelled")
        const prompt = hostedPrompt(input)
        if (prompt.length > 120_000) throw new Error("T3 Code prompt exceeds its 120000 character limit")
        client = await connect(paths)
        const modelSelection = await selection(client, input)
        const projectId = await projectFor(client, input.directory)
        if (input.signal?.aborted) throw new Error("Run cancelled")
        const launched = z.looseObject({ threadId: z.string(), runId: z.string().nullable() }).parse(await client.call("t3_thread_launch", { projectId, title: input.title, runtimeMode: "full-access", interactionMode: "default", workspaceStrategy: { type: "root" }, ...(modelSelection ? { modelSelection } : {}), clientRequestId: randomUUID() }))
        session = launched.threadId
        input.onSession?.(session)
        if (launched.runId) throw new Error("T3 Code unexpectedly started an idle thread")
        if (input.signal?.aborted) throw new Error("Run cancelled")
        const sent = z.looseObject({ runId: z.string() }).parse(await client.call("t3_thread_send", { threadId: session, message: prompt, mode: "auto", clientRequestId: randomUUID() }))
        const deadline = Date.now() + 3_600_000
        let runId = sent.runId
        while (true) {
          if (input.signal?.aborted) throw new Error("Run cancelled")
          const remaining = deadline - Date.now()
          if (remaining <= 0) throw new Error("T3 Code exceeded the one-hour run deadline")
          const value = Wait.parse(await client.call("t3_thread_wait", { threadId: session, runId: sent.runId, timeoutMs: Math.min(30_000, remaining), untilDelegatedWorkSettled: true }, { timeoutMs: Math.min(35_000, remaining + 1_000), signal: input.signal }))
          if (value.threadId !== session) throw new Error("T3 Code returned another thread while waiting for completion")
          if (value.timedOut) continue
          const status = value.resultRun?.status ?? value.status
          if (active.has(status)) continue
          if (!successful.has(status)) throw new Error(`T3 Code run ended with status ${status}`)
          runId = value.resultRun?.runId ?? value.runId ?? sent.runId
          finished = true
          break
        }
        reply = await finalReply(client, session, runId, input.signal)
      } catch (cause) {
        error = oneLine((cause as Error).message)
        if (client && session && !finished) try { await stop(client, session) } catch (cause) { error += `; ${(cause as Error).message}` }
      } finally {
        try { await client?.close() } catch (cause) { error = `${error ? `${error}; ` : ""}${oneLine((cause as Error).message)}` }
      }
      return { ok: !error, reply, session, resume: session ? `t3 thread show ${session}` : null, usage: null, error: error ? `T3 Code failed: ${error}` : null }
    },
    async cancel(paths, session) {
      const client = await (connect === connectT3 ? connectT3(paths, { verifyEnvironment: false }) : connect(paths))
      try { await stop(client, session) } finally { await client.close() }
    },
    async checks(paths, required) {
      const binary = t3Binary(paths)
      if (!binary) return []
      const version = await runCommand(binary, ["--version"], { timeoutMs: 15_000, env: { NOTION_ACCESS_TOKEN: undefined } })
      const checks: Check[] = [{ ok: version.code === 0, name: "T3 Code", detail: version.code === 0 ? version.stdout.trim() : "installed, but --version failed" }]
      try { checks.push({ ok: true, name: "T3 Code daemon", detail: t3Origin(paths) }) } catch (error) { checks.push({ ok: false, name: "T3 Code daemon", detail: oneLine((error as Error).message) }) }
      for (const name of required) checks.push({ ok: false, level: "warning", name: `T3 Code MCP ${name}`, detail: "T3 Code owns provider MCP configuration; its effective connection is unverified" })
      return checks
    },
  }
}

export const t3Code = createT3Code()
