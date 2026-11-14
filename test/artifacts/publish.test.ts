import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { artifacts } from "../../src/artifacts/index.ts"
import { ArtifactError, MANIFEST, publish, remove, type Bucket } from "../../src/artifacts/publish.ts"
import { EMPTY_CONFIG, type Config } from "../../src/shared/config.ts"
import { fakeNotion, tempHome, testContext } from "../helpers.ts"

const CONFIG: Config = { ...EMPTY_CONFIG, artifacts: { bucketUrl: "https://s3.example.test/bucket", publicUrl: "https://files.example.test" } }
const NOW = new Date("2026-11-14T12:00:00Z")
const TASK = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"

/** An in-memory bucket that records each write's type. */
function memoryBucket() {
  const objects = new Map<string, { text: string; type: string }>()
  const bucket: Bucket = {
    write: async (key, body, type) => void objects.set(key, { text: await body.text(), type }),
    list: async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix)),
    delete: async (key) => void objects.delete(key),
  }
  return { objects, bucket }
}

function setup() {
  const paths = tempHome()
  fs.mkdirSync(path.join(paths.projects, "acme"))
  const work = path.join(paths.home, "work")
  fs.mkdirSync(work)
  return { paths, work, ...memoryBucket() }
}

const rejects = (promise: Promise<unknown>, message: RegExp) => assert.rejects(promise, (error) => error instanceof ArtifactError && message.test(error.message))

test("a file is published under shared/ with its type and a manifest, and its link opens it", async () => {
  const { paths, work, objects, bucket } = setup()
  fs.writeFileSync(path.join(work, "shot one.png"), "png")
  const published = await publish({ source: path.join(work, "shot one.png") }, { paths, config: CONFIG, bucket, now: NOW, env: {} })
  const folder = published.url.match(/^https:\/\/files\.example\.test\/(shared\/2026-11\/[0-9a-f]{16}\/)shot%20one\.png$/u)?.[1]
  assert.ok(folder, published.url)
  assert.deepEqual(objects.get(`${folder}shot one.png`), { text: "png", type: "image/png" })
  const manifest = JSON.parse(objects.get(folder + MANIFEST)!.text)
  assert.deepEqual(manifest, { title: "shot one.png", project: null, task: null, automation: null, run: null, created: NOW.toISOString(), entry: "shot one.png", type: "image/png", bytes: 3, files: ["shot one.png"] })
  assert.deepEqual({ ...published, url: undefined }, { ...manifest, url: undefined })
})

test("a folder is a page: every file goes up, and the link opens its index.html", async () => {
  const { paths, work, objects, bucket } = setup()
  const site = path.join(work, "report")
  fs.mkdirSync(path.join(site, "assets"), { recursive: true })
  fs.writeFileSync(path.join(site, "index.html"), "<h1>hi</h1>")
  fs.writeFileSync(path.join(site, "assets", "app.js"), "1")
  const env = { NTNCODE_AUTOMATION: "AUT-3", NTNCODE_RUN: "RUN-9" }
  const published = await publish({ source: site, title: " Q4 report ", project: "acme", task: `https://app.notion.com/p/Task-${TASK.replaceAll("-", "")}` }, { paths, config: CONFIG, bucket, now: NOW, env })
  assert.match(published.url, /^https:\/\/files\.example\.test\/acme\/2026-11\/[0-9a-f]{16}\/index\.html$/u)
  assert.deepEqual([published.title, published.project, published.task, published.automation, published.run, published.files], ["Q4 report", "acme", TASK, "AUT-3", "RUN-9", ["assets/app.js", "index.html"]])
  assert.match(published.type, /^text\/html/u)
  assert.equal([...objects.keys()].length, 3)
  assert.match(objects.get([...objects.keys()].find((key) => key.endsWith("app.js"))!)!.type, /javascript/u)
})

test("what must not go public by accident is refused before anything is written", async () => {
  const { paths, work, objects, bucket } = setup()
  const context = { paths, config: CONFIG, bucket, now: NOW, env: {} }
  const site = path.join(work, "site")
  fs.mkdirSync(site)
  await rejects(publish({ source: site }, context), /no index\.html/u)
  fs.writeFileSync(path.join(site, "index.html"), "x")
  fs.writeFileSync(path.join(site, ".env"), "SECRET=1")
  await rejects(publish({ source: site }, context), /\.env is a dot-file/u)
  fs.rmSync(path.join(site, ".env"))
  fs.symlinkSync("/etc/hostname", path.join(site, "host"))
  await rejects(publish({ source: site }, context), /host is a link/u)
  await rejects(publish({ source: path.join(work, "missing.png") }, context), /does not exist/u)
  fs.writeFileSync(path.join(work, "a.png"), "x")
  await rejects(publish({ source: path.join(work, "a.png"), project: "nope" }, context), /no project "nope"/u)
  await rejects(publish({ source: path.join(work, "a.png"), project: "../acme" }, context), /no project/u)
  await rejects(publish({ source: path.join(work, "a.png"), task: "tomorrow" }, context), /not a Notion task/u)
  await rejects(publish({ source: path.join(work, "a.png"), title: "  " }, context), /title/u)
  await rejects(publish({ source: path.join(work, "a.png") }, { ...context, config: EMPTY_CONFIG }), /no bucket configured/u)
  assert.equal(objects.size, 0)
})

test("a publish that fails partway takes back what went up", async () => {
  const { paths, work, objects, bucket } = setup()
  const site = path.join(work, "site")
  fs.mkdirSync(site)
  fs.writeFileSync(path.join(site, "a.html"), "a")
  fs.writeFileSync(path.join(site, "index.html"), "i")
  let writes = 0
  const failing: Bucket = { ...bucket, write: (key, body, type) => (++writes === 2 ? Promise.reject(new Error("503 Slow Down")) : bucket.write(key, body, type)) }
  await rejects(publish({ source: site }, { paths, config: CONFIG, bucket: failing, now: NOW, env: {} }), /503 Slow Down; nothing was left public/u)
  assert.equal(objects.size, 0)
  const stuck: Bucket = { ...failing, delete: () => Promise.reject(new Error("offline")) }
  writes = 0
  await rejects(publish({ source: site }, { paths, config: CONFIG, bucket: stuck, now: NOW, env: {} }), /still public: https:\/\/files\.example\.test\/shared\/2026-11\/[0-9a-f]{16}\/a\.html$/u)
  await rejects(remove("https://files.example.test/shared/2026-11/0123456789abcdef/a.png", { config: CONFIG, bucket: { ...bucket, list: () => Promise.reject(new Error("offline")) } }), /refused the delete: offline/u)
})

test("delete removes one publish by its link, and refuses anything else", async () => {
  const { paths, work, objects, bucket } = setup()
  fs.writeFileSync(path.join(work, "a.png"), "x")
  const kept = await publish({ source: path.join(work, "a.png") }, { paths, config: CONFIG, bucket, now: NOW, env: {} })
  const gone = await publish({ source: path.join(work, "a.png") }, { paths, config: CONFIG, bucket, now: NOW, env: {} })
  objects.set("uploads/2026-11/0123456789abcdef/other.png", { text: "x", type: "image/png" })
  assert.deepEqual(await remove(gone.url, { config: CONFIG, bucket }), { url: gone.url, deleted: 1 })
  assert.equal(objects.size, 3, "the other publish and the foreign file stay")
  await rejects(remove(gone.url, { config: CONFIG, bucket }), /already deleted/u)
  await rejects(remove("https://files.example.test/uploads/2026-11/0123456789abcdef/other.png", { config: CONFIG, bucket }), /not published by ntncode/u)
  await rejects(remove("https://elsewhere.test/shared/2026-11/0123456789abcdef/a.png", { config: CONFIG, bucket }), /not in the artifacts bucket/u)
  await rejects(remove("https://files.example.test/shared/a.png", { config: CONFIG, bucket }), /not an artifact's link/u)
  assert.ok(objects.has(new URL(kept.url).pathname.slice(1)))
})

test("doctor warns without a bucket, and errors without the access key", () => {
  const paths = tempHome()
  const saved = { id: process.env.S3_ACCESS_KEY_ID, secret: process.env.S3_SECRET_ACCESS_KEY }
  try {
    delete process.env.S3_ACCESS_KEY_ID
    delete process.env.S3_SECRET_ACCESS_KEY
    const check = (config: Config) => (artifacts.checks!(testContext(paths, fakeNotion({}), config)) as { ok: boolean; level?: string; detail: string }[])[0]!
    assert.equal(check(EMPTY_CONFIG).level, "warning")
    assert.deepEqual([check(CONFIG).level, check(CONFIG).detail], ["error", "no S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY"])
    fs.writeFileSync(paths.secrets, "S3_ACCESS_KEY_ID=a\nexport S3_SECRET_ACCESS_KEY='b'\n")
    assert.equal(check(CONFIG).ok, true)
  } finally {
    for (const [name, value] of [["S3_ACCESS_KEY_ID", saved.id], ["S3_SECRET_ACCESS_KEY", saved.secret]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
