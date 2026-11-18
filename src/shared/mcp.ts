import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { z } from "zod"

export interface CallOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** A local app's MCP control plane. Tool results are unwrapped, and protocol/tool errors throw. */
export interface McpClient {
  call(name: string, args: Record<string, unknown>, options?: CallOptions): Promise<unknown>
  close(): Promise<void>
}

const ToolResult = z.looseObject({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
})

function toolValue(value: unknown): unknown {
  const result = ToolResult.parse(value)
  const text = result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? ""
  if (result.isError) throw new Error(text || "MCP tool failed")
  if (result.structuredContent !== undefined) return result.structuredContent
  try {
    return JSON.parse(text)
  } catch {
    throw new Error("MCP tool returned no structured result")
  }
}

const RpcMessage = z.looseObject({
  id: z.union([z.number(), z.string()]).optional(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string() }).optional(),
  method: z.string().optional(),
})

/** Starts only a bridge, never the app's daemon. Each connection has its own request IDs and deadlines. */
export async function stdioMcp(command: string, args: string[], options: { cwd?: string; env?: Record<string, string | undefined>; onStart?: (pid: number) => void } = {}): Promise<McpClient> {
  const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] })
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let nextId = 0
  let ended: Error | null = null
  let stderr = ""
  const stop = (error: Error) => {
    ended = error
    for (const item of pending.values()) item.reject(error)
    pending.clear()
  }
  child.on("error", (error) => stop(error))
  child.on("close", (code) => stop(new Error(`MCP bridge exited (${code})${stderr ? `: ${stderr.trim()}` : ""}`)))
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_000) })
  child.stdin.on("error", (error) => stop(error))
  const lines = createInterface({ input: child.stdout })
  lines.on("line", (line) => {
    if (!line.trim()) return
    let message: z.infer<typeof RpcMessage>
    try {
      if (line.length > 8 * 1024 * 1024) throw new Error("MCP response exceeds 8 MiB")
      message = RpcMessage.parse(JSON.parse(line))
    } catch (error) {
      stop(new Error(`Invalid MCP response: ${(error as Error).message}`))
      child.kill()
      return
    }
    // A bridge may send notifications or server requests. This client has no sampling or roots capabilities.
    if (message.method) {
      if (message.id !== undefined) child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client capability not supported" } })}\n`)
      return
    }
    const item = typeof message.id === "number" ? pending.get(message.id) : undefined
    if (!item) return
    if (message.error) item.reject(new Error(message.error.message))
    else item.resolve(message.result)
  })
  const request = (method: string, params: Record<string, unknown>, callOptions: CallOptions = {}): Promise<unknown> => {
    if (ended) return Promise.reject(ended)
    if (callOptions.signal?.aborted) return Promise.reject(new Error("Run cancelled"))
    const id = ++nextId
    return new Promise((resolve, reject) => {
      const finish = (error: Error | null, value?: unknown) => {
        pending.delete(id)
        clearTimeout(timer)
        callOptions.signal?.removeEventListener("abort", abort)
        if (error) reject(error)
        else resolve(value)
      }
      const abort = () => finish(new Error("Run cancelled"))
      const timer = setTimeout(() => finish(new Error(`MCP ${method} timed out`)), callOptions.timeoutMs ?? 45_000)
      pending.set(id, { resolve: (value) => finish(null, value), reject: (error) => finish(error) })
      callOptions.signal?.addEventListener("abort", abort, { once: true })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => { if (error) finish(error) })
    })
  }
  const close = async () => {
    stop(new Error("MCP connection closed"))
    lines.close()
    child.stdin.end()
    if (child.exitCode !== null || child.signalCode) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve() }, 1_000)
      child.once("close", () => { clearTimeout(timer); resolve() })
      child.kill("SIGTERM")
    })
  }
  try {
    if (child.pid) options.onStart?.(child.pid)
    await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "notion-code", version: "0.4.1" } }, { timeoutMs: 15_000 })
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    return { call: async (name, args, callOptions) => toolValue(await request("tools/call", { name, arguments: args }, callOptions)), close }
  } catch (error) {
    await close()
    throw error
  }
}

/** Streamable HTTP MCP on the same machine. Credentials never follow a redirect to another origin. */
export async function httpMcp(url: string, headers: Record<string, string>): Promise<McpClient> {
  const target = new URL(url)
  if (!["http:", "https:"].includes(target.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.username || target.password) throw new Error("MCP endpoint must be a local loopback URL")
  let nextId = 0
  let session: string | null = null
  let closed = false
  const request = async (method: string, params: Record<string, unknown>, options: CallOptions = {}, notification = false): Promise<unknown> => {
    if (closed) throw new Error("MCP connection closed")
    const id = ++nextId
    const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 45_000), ...(options.signal ? [options.signal] : [])])
    const response = await fetch(target, {
      method: "POST", redirect: "error", signal,
      headers: { ...headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(session ? { "Mcp-Session-Id": session } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(!notification ? { id } : {}), method, params }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`MCP ${method} returned HTTP ${response.status}`)
    }
    session = response.headers.get("Mcp-Session-Id") ?? session
    if (notification) { await response.body?.cancel(); return null }
    let value: unknown
    if (response.headers.get("Content-Type")?.includes("text/event-stream")) {
      const reader = response.body?.getReader()
      if (!reader) throw new Error("MCP returned an empty event stream")
      const decoder = new TextDecoder()
      let buffer = ""
      let received = 0
      try {
        while (value === undefined) {
          const chunk = await reader.read()
          buffer = (buffer + decoder.decode(chunk.value, { stream: !chunk.done })).replaceAll("\r\n", "\n")
          received += chunk.value?.length ?? 0
          if (received > 8 * 1024 * 1024) throw new Error("MCP response exceeds 8 MiB")
          let boundary: number
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
            if (!data) continue
            const message = RpcMessage.parse(JSON.parse(data))
            if (message.id === id) { value = message; break }
          }
          if (chunk.done) break
        }
      } finally { await reader.cancel() }
    } else {
      const body = await response.text()
      if (body.length > 8 * 1024 * 1024) throw new Error("MCP response exceeds 8 MiB")
      value = JSON.parse(body)
    }
    const message = RpcMessage.parse(value)
    if (message.id !== id) throw new Error("MCP response ID does not match its request")
    if (message.error) throw new Error(message.error.message)
    return message.result
  }
  await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "notion-code", version: "0.4.1" } })
  await request("notifications/initialized", {}, {}, true)
  return {
    call: async (name, args, options) => toolValue(await request("tools/call", { name, arguments: args }, options)),
    async close() {
      closed = true
      if (session) {
        const response = await fetch(target, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(5_000), headers: { ...headers, "Mcp-Session-Id": session } })
        await response.body?.cancel()
      }
    },
  }
}
