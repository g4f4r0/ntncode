import fs from "node:fs"
import path from "node:path"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"
import type { Paths } from "../shared/config.ts"
import { httpMcp, type McpClient } from "../shared/mcp.ts"
import { runCommand } from "../shared/process.ts"
import { assertHostedEnvironment, findBinary } from "./agent.ts"

export const t3Binary = (paths: Paths) => findBinary("t3", [path.join(paths.home, ".local/bin")])

/** Read the existing daemon's endpoint; automation never starts or reconfigures T3. */
export function t3Origin(paths: Paths, verifyEnvironment = true): string {
  const file = path.join(process.env.T3CODE_HOME || path.join(paths.home, ".t3"), "userdata/server-runtime.json")
  let runtime: { origin: string; pid: number }
  try {
    runtime = z.object({ origin: z.string(), pid: z.number().int().positive() }).parse(JSON.parse(fs.readFileSync(file, "utf8")))
  } catch { throw new Error("T3 Code daemon isn't running: open T3 Code on this server") }
  const url = new URL(runtime.origin)
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("T3 Code daemon must use a local loopback origin")
  try { process.kill(runtime.pid, 0) } catch { throw new Error("T3 Code daemon isn't running: open T3 Code on this server") }
  if (verifyEnvironment) assertHostedEnvironment(runtime.pid)
  return url.origin
}

interface ConnectionDeps {
  /** Cancellation must remain possible when a running daemon has an unsafe environment. */
  verifyEnvironment?: boolean
  run?: typeof runCommand
  fetch?: typeof fetch
  mcp?: typeof httpMcp
  binary?: (paths: Paths) => string | null
  origin?: (paths: Paths) => string
}

const Ownership = z.strictObject({
  label: z.string().regex(/^notion-code-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
  pid: z.number().int().positive(),
  cleanupPending: z.boolean(),
  sessions: z.array(z.string().min(1)),
})
const activeConnections = new Set<string>()
const pendingCleanup = new Set<string>()
const processAlive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH" }
}

const Sessions = z.array(z.looseObject({ sessionId: z.string(), subject: z.string().optional(), client: z.looseObject({ label: z.string().optional() }).optional() }))

/**
 * T3's MCP endpoint requires its supported OAuth credential, not a generic CLI bearer token.
 * Bootstrap approval with a temporary CLI token, exchange PKCE, then revoke both owned sessions.
 * Credentials stay in memory and no auth policy or existing session is changed.
 */
export async function connectT3(paths: Paths, deps: ConnectionDeps = {}): Promise<McpClient> {
  const binary = (deps.binary ?? t3Binary)(paths)
  if (!binary) throw new Error("T3 Code (t3) isn't installed")
  const origin = deps.origin ? deps.origin(paths) : t3Origin(paths, deps.verifyEnvironment !== false)
  const run = deps.run ?? runCommand
  const request = deps.fetch ?? fetch
  const folder = path.join(paths.state, "agents/t3-connections")
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  const label = `notion-code-${randomUUID()}`
  const file = path.join(folder, `${label}.json`)
  const owned = new Set<string>()
  let bootstrap: string | null = null
  let client: McpClient | null = null
  let closed = false
  const cli = async (args: string[]) => {
    const result = await run(binary, ["auth", "session", ...args], { timeoutMs: 15_000, env: { NOTION_ACCESS_TOKEN: undefined } })
    // Auth output contains secrets. Never include stdout/stderr in errors.
    if (result.code !== 0) throw new Error(`T3 Code auth session ${args[0]} failed`)
    return result.stdout
  }
  const list = async () => Sessions.parse(JSON.parse(await cli(["list", "--json"])))
  const matching = (sessions: z.infer<typeof Sessions>, owner: string) => sessions.filter((session) =>
    (session.subject === "mcp-client" && session.client?.label === owner) ||
    (session.subject === "cli-issued-session" && session.client?.label === `${owner} bootstrap`))
  const revoke = async (id: string) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await cli(["revoke", id]); return } catch {}
    }
    throw new Error("T3 Code session revocation failed after three attempts")
  }
  const save = (cleanupPending = false) => {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify({ label, pid: process.pid, cleanupPending, sessions: [...owned] }), { mode: 0o600, flag: "wx" })
      fs.renameSync(temporary, file)
    } finally { fs.rmSync(temporary, { force: true }) }
  }
  // A crash can occur after issuance but before the response arrives. Exact random labels
  // recover both sessions without ever writing a bearer token or PKCE verifier to disk.
  for (const name of fs.readdirSync(folder).filter((name) => name.endsWith(".json"))) {
    const staleFile = path.join(folder, name)
    const owner = Ownership.parse(JSON.parse(fs.readFileSync(staleFile, "utf8")))
    if (name !== `${owner.label}.json`) throw new Error("Invalid T3 Code connection ownership file")
    if (activeConnections.has(owner.label) || (!owner.cleanupPending && !pendingCleanup.has(owner.label) && processAlive(owner.pid))) continue
    activeConnections.add(owner.label)
    try {
      // List is authoritative: expired or already revoked IDs need no further action.
      // Never revoke an ID from a ledger unless its live label also proves ownership.
      for (const session of matching(await list(), owner.label)) await revoke(session.sessionId)
      fs.rmSync(staleFile)
      pendingCleanup.delete(owner.label)
    } finally { activeConnections.delete(owner.label) }
  }
  const discover = async () => {
    const sessions = matching(await list(), label)
    for (const session of sessions) owned.add(session.sessionId)
    save()
    const oauth = sessions.filter((session) => session.subject === "mcp-client")
    if (oauth.length > 1) throw new Error("T3 Code returned ambiguous owned OAuth sessions")
    return oauth.length
  }
  const cleanup = async () => {
    if (closed) return
    pendingCleanup.add(label)
    try {
      // Disk failure must never prevent credential revocation. The in-memory pending
      // set permits retry in this process; a later process will see the dead owner PID.
      try { save(true) } catch {}
      const failures: string[] = []
      try { await client?.close() } catch { failures.push("MCP close") }
      // Always discover, including when issuance or exchange lost their response.
      try { for (const session of matching(await list(), label)) owned.add(session.sessionId) } catch { failures.push("session lookup") }
      for (const id of owned) {
        try { await revoke(id); owned.delete(id) } catch { failures.push("session revocation after three attempts") }
      }
      if (failures.length) {
        try { save(true) } catch {}
        throw new Error(`T3 Code credential cleanup failed (${[...new Set(failures)].join(", ")})`)
      }
      try { fs.rmSync(file, { force: true }) } catch { throw new Error("T3 Code credential cleanup failed (ownership file removal)") }
      closed = true
      pendingCleanup.delete(label)
    } finally { activeConnections.delete(label) }
  }
  const post = async (route: string, body: unknown, bearer?: string, form = false): Promise<unknown> => {
    const response = await request(`${origin}${route}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`T3 Code OAuth ${route} returned HTTP ${response.status}`) }
    return response.json()
  }
  save()
  activeConnections.add(label)
  try {
    const scopes = ["orchestration:read", "orchestration:operate", "settings:write", "source-control:write", "access:write"]
    const issued = z.object({ sessionId: z.string(), token: z.string() }).parse(JSON.parse(await cli(["issue", "--json", "--ttl", "5m", "--label", `${label} bootstrap`, ...scopes.flatMap((scope) => ["--scope", scope])])))
    owned.add(issued.sessionId)
    save()
    bootstrap = issued.token
    const redirect = "http://127.0.0.1:9911/callback"
    const registered = z.object({ client_id: z.string() }).parse(await post("/oauth/mcp/register", { client_name: label, redirect_uris: [redirect], token_endpoint_auth_method: "none" }))
    const verifier = randomBytes(48).toString("base64url")
    const state = randomBytes(24).toString("base64url")
    const authorization = { response_type: "code", client_id: registered.client_id, redirect_uri: redirect, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state, resource: `${origin}/mcp` }
    const approval = z.object({ csrfToken: z.string() }).parse(await post("/oauth/mcp/approval", authorization, bootstrap))
    const decision = z.object({ redirectTo: z.string() }).parse(await post("/oauth/mcp/decision", { authorization, decision: { _tag: "browser-session", access: "full-access", csrfToken: approval.csrfToken } }, bootstrap))
    const result = new URL(decision.redirectTo)
    if (result.origin + result.pathname !== redirect || result.searchParams.get("state") !== state || (result.searchParams.has("iss") && result.searchParams.get("iss") !== origin) || !result.searchParams.get("code")) throw new Error("T3 Code OAuth authorization response is invalid")
    const token = z.object({ access_token: z.string(), token_type: z.literal("Bearer"), expires_in: z.number().min(3_660) }).parse(await post("/oauth/mcp/token", { grant_type: "authorization_code", code: result.searchParams.get("code")!, redirect_uri: redirect, client_id: registered.client_id, code_verifier: verifier, resource: `${origin}/mcp` }, undefined, true))
    if (await discover() !== 1) throw new Error("T3 Code OAuth session couldn't be identified for cleanup")
    // Bootstrap access is no longer needed once OAuth is established.
    await cli(["revoke", issued.sessionId])
    owned.delete(issued.sessionId)
    save()
    bootstrap = null
    client = await (deps.mcp ?? httpMcp)(`${origin}/mcp`, { Authorization: `Bearer ${token.access_token}` })
    return { call: (name, args, options) => client!.call(name, args, options), close: cleanup }
  } catch {
    let cleanupError = ""
    try { await cleanup() } catch (error) { cleanupError = `; ${(error as Error).message}` }
    // Network and parser errors may contain token-bearing bodies or URLs.
    throw new Error(`T3 Code MCP authentication failed${cleanupError}`)
  } finally { bootstrap = null; if (!client) activeConnections.delete(label) }
}
