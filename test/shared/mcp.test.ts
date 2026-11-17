import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { httpMcp, stdioMcp } from "../../src/shared/mcp.ts"
import { tempHome } from "../helpers.ts"

function bridge() {
  const paths = tempHome()
  const file = path.join(paths.home, "bridge.js")
  fs.writeFileSync(file, `
    const {createInterface} = require('node:readline');
    const lines=createInterface({input:process.stdin});
    lines.on('line',line=>{
      const m=JSON.parse(line);
      if(m.id===undefined)return;
      let result={protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fake',version:'1'}};
      if(m.method==='tools/call') {
        const name=m.params.name;
        if(name==='hang')return;
        if(name==='exit'){process.exit(1);return;}
        if(name==='bad'){process.stdout.write('not json\\n');return;}
        result=name==='error'?{isError:true,content:[{type:'text',text:'permission denied'}]}:
          name==='text'?{content:[{type:'text',text:'{"from":"text"}'}]}:
          {structuredContent:{from:'structured',args:m.params.arguments}};
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });
  `)
  return { paths, file }
}

test("stdio MCP initializes, unwraps structured and JSON text results, and propagates tool failures", async () => {
  const { paths, file } = bridge()
  const client = await stdioMcp(process.execPath, [file])
  try {
    assert.deepEqual(await client.call("ok", { value: "stdin, not shell" }), { from: "structured", args: { value: "stdin, not shell" } })
    assert.deepEqual(await client.call("text", {}), { from: "text" })
    await assert.rejects(client.call("error", {}), /permission denied/u)
  } finally { await client.close(); fs.rmSync(paths.home, { recursive: true, force: true }) }
})

test("stdio MCP bounds waits, cancels requests, and rejects a broken bridge", async () => {
  const { paths, file } = bridge()
  const client = await stdioMcp(process.execPath, [file])
  try {
    await assert.rejects(client.call("hang", {}, { timeoutMs: 10 }), /timed out/u)
    const abort = new AbortController()
    const waiting = client.call("hang", {}, { signal: abort.signal })
    abort.abort()
    await assert.rejects(waiting, /cancelled/u)
    await assert.rejects(client.call("bad", {}), /Invalid MCP response/u)
  } finally { await client.close(); fs.rmSync(paths.home, { recursive: true, force: true }) }
})

test("HTTP MCP handles SSE and session headers, and closes its session", async () => {
  let deleted = false
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      assert.equal(request.headers.get("Authorization"), "Bearer temporary")
      if (request.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }) }
      const message = await request.json() as { id?: number; method: string; params: { name?: string } }
      if (!message.id) return new Response(null, { status: 202 })
      if (message.method !== "initialize") assert.equal(request.headers.get("Mcp-Session-Id"), "session")
      const result = message.method === "initialize" ? { protocolVersion: "2024-11-05" } : { structuredContent: { done: true } }
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`, { headers: { "Content-Type": "text/event-stream", "Mcp-Session-Id": "session" } })
    },
  })
  try {
    const client = await httpMcp(`http://127.0.0.1:${server.port}/mcp`, { Authorization: "Bearer temporary" })
    assert.deepEqual(await client.call("test", {}), { done: true })
    await client.close()
    assert.equal(deleted, true)
  } finally { await server.stop(true) }
})

test("HTTP MCP refuses remote endpoints and mismatched response IDs", async () => {
  await assert.rejects(httpMcp("https://external.invalid/mcp", {}), /local loopback/u)
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ jsonrpc: "2.0", id: 999, result: {} }) })
  try { await assert.rejects(httpMcp(`http://127.0.0.1:${server.port}/mcp`, {}), /ID does not match/u) }
  finally { await server.stop(true) }
})

test("HTTP MCP accepts SSE CRLF boundaries split between network chunks", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const message = await request.json() as { id?: number }
    if (!message.id) return new Response(null, { status: 202 })
    return new Response(new ReadableStream({ async start(controller) {
      const encoder = new TextEncoder()
      for (const part of [`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { structuredContent: { ok: true } } })}\r`, "\n\r", "\n"]) {
        controller.enqueue(encoder.encode(part))
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      controller.close()
    } }), { headers: { "Content-Type": "text/event-stream" } })
  } })
  try {
    const client = await httpMcp(`http://127.0.0.1:${server.port}/mcp`, {})
    assert.deepEqual(await client.call("test", {}), { ok: true })
    await client.close()
  } finally { await server.stop(true) }
})
