import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { CommandResult } from "../../src/shared/process.ts"
import { connectT3, t3Origin } from "../../src/agents/t3-connection.ts"
import { tempHome } from "../helpers.ts"

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }) })

function fixture(failure?: string) {
  const paths = tempHome(); homes.push(paths.home)
  const commands: string[][] = []
  const posts: { route: string; body: Record<string, string>; headers: Headers; redirect: RequestRedirect | undefined }[] = []
  let label = ""
  let state = ""
  let oauthIssued = false
  let bootstrapRevoked = false
  let revoked = false
  let closed = false
  const run = async (_binary: string, args: string[]): Promise<CommandResult> => {
    commands.push(args)
    let data: unknown = ""
    if (args[2] === "issue") { revoked = false; bootstrapRevoked = false; oauthIssued = false; label = args[args.indexOf("--label") + 1]!.replace(/ bootstrap$/u, ""); data = { sessionId: "bootstrap", token: "BOOTSTRAP_SECRET" } }
    if (args[2] === "list") data = [...(oauthIssued && !revoked ? [{ sessionId: "oauth", subject: "mcp-client", client: { label } }] : []), ...(label && !bootstrapRevoked ? [{ sessionId: "bootstrap", subject: "cli-issued-session", client: { label: `${label} bootstrap` } }] : []), { sessionId: "other", subject: "mcp-client", client: { label: `${label}-other` } }]
    if (args[2] === "revoke" && args[3] === "bootstrap") bootstrapRevoked = true
    if (args[2] === "revoke" && args[3] === "oauth") revoked = true
    return { code: 0, stdout: typeof data === "string" ? data : JSON.stringify(data), stderr: "", error: null, timedOut: false, pid: 1 }
  }
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(url)).pathname
    const body = init?.headers && new Headers(init.headers).get("Content-Type") === "application/x-www-form-urlencoded" ? Object.fromEntries(new URLSearchParams(String(init.body))) : JSON.parse(String(init?.body))
    posts.push({ route, body, headers: new Headers(init?.headers), redirect: init?.redirect })
    if (route.endsWith("token")) oauthIssued = true
    if (failure === route) throw new Error("BOOTSTRAP_SECRET ACCESS_SECRET must not escape")
    let value: unknown
    if (route.endsWith("register")) value = { client_id: "client" }
    if (route.endsWith("approval")) { state = body.state; value = { csrfToken: "csrf" } }
    if (route.endsWith("decision")) value = { redirectTo: `http://127.0.0.1:9911/callback?code=code&state=${failure === "state" ? "wrong" : state}&iss=http%3A%2F%2F127.0.0.1%3A3773` }
    if (route.endsWith("token")) value = { access_token: "ACCESS_SECRET", token_type: "Bearer", expires_in: failure === "short" ? 30 : 2_592_000 }
    return Response.json(value)
  }) as typeof fetch
  const deps = {
    run, fetch: request, binary: () => "/t3", origin: () => "http://127.0.0.1:3773",
    mcp: async (_url: string, headers: Record<string, string>) => { expect(headers.Authorization).toBe("Bearer ACCESS_SECRET"); if (failure === "mcp") throw new Error("ACCESS_SECRET"); return { call: async () => ({}), close: async () => { closed = true } } },
  }
  return { paths, deps, commands, posts, revoked: () => revoked, closed: () => closed }
}

describe("T3 Code local OAuth connection", () => {
  test("uses supported PKCE and revokes only its two sessions without persisting tokens", async () => {
    const f = fixture()
    const c = await connectT3(f.paths, f.deps)
    expect(f.commands.find((args) => args[2] === "issue")).toContain("5m")
    expect(f.commands.filter((args) => args[2] === "revoke").map((args) => args[3])).toEqual(["bootstrap"])
    const approval = f.posts.find((post) => post.route.endsWith("approval"))!
    expect(approval.body.code_challenge_method).toBe("S256")
    expect(approval.body.code_challenge).not.toBe(f.posts.find((post) => post.route.endsWith("token"))!.body.code_verifier)
    expect(approval.headers.get("Authorization")).toBe("Bearer BOOTSTRAP_SECRET")
    expect(f.posts.every((post) => post.redirect === "error")).toBe(true)
    await c.close(); await c.close()
    expect(f.closed()).toBe(true)
    expect(f.commands.filter((args) => args[2] === "revoke").map((args) => args[3])).toEqual(["bootstrap", "oauth"])
    expect(fs.readdirSync(path.join(f.paths.state, "agents/t3-connections"))).toEqual([])
  })

  test("cleans partial OAuth and never exposes credential-bearing failures", async () => {
    for (const failure of ["mcp", "/oauth/mcp/token", "short"]) {
      const f = fixture(failure)
      await expect(connectT3(f.paths, f.deps)).rejects.toThrow("T3 Code MCP authentication failed")
      expect(f.revoked()).toBe(true)
      expect(f.commands.some((args) => args[3] === "other")).toBe(false)
    }
  })

  test("rejects OAuth state mismatch before token exchange", async () => {
    const f = fixture("state")
    await expect(connectT3(f.paths, f.deps)).rejects.toThrow("authentication failed")
    expect(f.posts.some((post) => post.route.endsWith("token"))).toBe(false)
    expect(f.commands.filter((args) => args[2] === "revoke").map((args) => args[3])).toEqual(["bootstrap"])
  })

  test("retries revocation failures while keeping ownership IDs available", async () => {
    const f = fixture()
    const run = f.deps.run
    let attempts = 0
    f.deps.run = async (binary, args) => {
      if (args[2] === "revoke" && args[3] === "oauth" && ++attempts < 3) return { code: 1, stdout: "", stderr: "", error: null, timedOut: false, pid: 1 }
      return run(binary, args)
    }
    const c = await connectT3(f.paths, f.deps)
    await c.close()
    expect(attempts).toBe(3)
    expect(f.revoked()).toBe(true)
  })


  test("records only ownership metadata while the connection is active", async () => {
    const f = fixture()
    const c = await connectT3(f.paths, f.deps)
    const folder = path.join(f.paths.state, "agents/t3-connections")
    const files = fs.readdirSync(folder)
    expect(files).toHaveLength(1)
    const saved = fs.readFileSync(path.join(folder, files[0]!), "utf8")
    const owner = JSON.parse(saved)
    expect(Object.keys(owner).sort()).toEqual(["cleanupPending", "label", "pid", "sessions"])
    expect(owner.pid).toBe(process.pid)
    expect(owner.sessions).toEqual(["oauth"])
    expect(saved).not.toMatch(/SECRET|verifier|token|csrf/u)
    expect(fs.statSync(path.join(folder, files[0]!)).mode & 0o777).toBe(0o600)
    await c.close()
  })

  test("reaps crash leftovers by exact labels and preserves a live concurrent owner", async () => {
    const f = fixture()
    const folder = path.join(f.paths.state, "agents/t3-connections")
    fs.mkdirSync(folder, { recursive: true })
    const dead = "notion-code-00000000-0000-4000-8000-000000000001"
    const live = "notion-code-00000000-0000-4000-8000-000000000002"
    // No captured IDs: emulate death after remote issuance but before parsing its response.
    for (const [label, pid] of [[dead, 2147483647], [live, process.pid]] as const) fs.writeFileSync(path.join(folder, `${label}.json`), JSON.stringify({ label, pid, cleanupPending: false, sessions: [] }))
    const run = f.deps.run
    const extra = [
      { sessionId: "lost-bootstrap", subject: "cli-issued-session", client: { label: `${dead} bootstrap` } },
      { sessionId: "lost-oauth", subject: "mcp-client", client: { label: dead } },
      { sessionId: "live-oauth", subject: "mcp-client", client: { label: live } },
      { sessionId: "similar-label", subject: "mcp-client", client: { label: `${dead}-other` } },
    ]
    f.deps.run = async (binary, args) => {
      const result = await run(binary, args)
      if (args[2] === "list") result.stdout = JSON.stringify([...JSON.parse(result.stdout), ...extra])
      return result
    }
    const c = await connectT3(f.paths, f.deps)
    const revoked = f.commands.filter((args) => args[2] === "revoke").map((args) => args[3])
    expect(revoked).toContain("lost-bootstrap")
    expect(revoked).toContain("lost-oauth")
    expect(revoked).not.toContain("live-oauth")
    expect(revoked).not.toContain("similar-label")
    expect(fs.existsSync(path.join(folder, `${dead}.json`))).toBe(false)
    expect(fs.existsSync(path.join(folder, `${live}.json`))).toBe(true)
    await c.close()
  })

  test("keeps failed cleanup recoverable by the next connection in the same process", async () => {
    const f = fixture()
    const run = f.deps.run
    let fail = true
    f.deps.run = async (binary, args) => {
      if (fail && args[2] === "revoke" && args[3] === "oauth") return { code: 1, stdout: "", stderr: "", error: null, timedOut: false, pid: 1 }
      return run(binary, args)
    }
    const c = await connectT3(f.paths, f.deps)
    await expect(c.close()).rejects.toThrow("credential cleanup failed")
    const folder = path.join(f.paths.state, "agents/t3-connections")
    const saved = path.join(folder, fs.readdirSync(folder)[0]!)
    expect(JSON.parse(fs.readFileSync(saved, "utf8")).cleanupPending).toBe(true)
    fail = false
    const next = await connectT3(f.paths, f.deps)
    expect(fs.existsSync(saved)).toBe(false)
    await next.close()
    expect(fs.readdirSync(folder)).toEqual([])
  })

  test("still closes MCP and revokes credentials when ownership storage fails", async () => {
    const f = fixture()
    const c = await connectT3(f.paths, f.deps)
    const folder = path.join(f.paths.state, "agents/t3-connections")
    const moved = `${folder}-offline`
    const saved = fs.readdirSync(folder)[0]!
    fs.renameSync(folder, moved)
    fs.writeFileSync(folder, "storage unavailable")
    try {
      await expect(c.close()).rejects.toThrow("ownership file removal")
      expect(f.closed()).toBe(true)
      expect(f.revoked()).toBe(true)
      expect(JSON.parse(fs.readFileSync(path.join(moved, saved), "utf8")).cleanupPending).toBe(false)
    } finally {
      fs.rmSync(folder)
      fs.renameSync(moved, folder)
    }
    const next = await connectT3(f.paths, f.deps)
    expect(fs.existsSync(path.join(folder, saved))).toBe(false)
    await next.close()
    expect(fs.readdirSync(folder)).toEqual([])
  })

  test("rejects nonlocal daemon metadata before any auth operation", () => {
    const f = fixture()
    const folder = path.join(f.paths.home, ".t3/userdata"); fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, "server-runtime.json"), JSON.stringify({ pid: process.pid, origin: "https://example.com" }))
    const previous = process.env.T3CODE_HOME; delete process.env.T3CODE_HOME
    try { expect(() => t3Origin(f.paths)).toThrow("local loopback") } finally { if (previous !== undefined) process.env.T3CODE_HOME = previous }
    expect(f.commands).toHaveLength(0)
  })
})
