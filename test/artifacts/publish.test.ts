import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { artifacts } from "../../src/artifacts/index.ts"
import { ArtifactError, kebab, list, publish, remove, type Bucket } from "../../src/artifacts/publish.ts"
import { EMPTY_CONFIG, type Config } from "../../src/shared/config.ts"
import { fakeNotion, tempHome, testContext } from "../helpers.ts"

const CONFIG: Config = { ...EMPTY_CONFIG, artifacts: { bucketUrl: "https://s3.example.test/bucket", publicUrl: "https://files.example.test" } }
const NOW = new Date("2026-11-14T12:00:00Z")
const PUBLIC = "https://files.example.test/"

/** An in-memory bucket that records each write's type and time. */
function memoryBucket() {
  const objects = new Map<string, { text: string; type: string; modified: string }>()
  let clock = 0
  const bucket: Bucket = {
    write: async (key, body, type) => void objects.set(key, { text: await body.text(), type, modified: new Date(NOW.getTime() + clock++ * 1000).toISOString() }),
    list: async (prefix) => [...objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, size: value.text.length, modified: value.modified })),
    delete: async (key) => void objects.delete(key),
  }
  return { objects, bucket }
}

function setup() {
  const paths = tempHome()
  fs.mkdirSync(path.join(paths.projects, "acme"))
  const work = path.join(paths.home, "work")
  fs.mkdirSync(work)
  const { objects, bucket } = memoryBucket()
  return { paths, work, objects, bucket, context: { paths, config: CONFIG, bucket, now: NOW } }
}

function page(work: string, name: string): string {
  const site = path.join(work, name)
  fs.mkdirSync(path.join(site, "assets"), { recursive: true })
  fs.writeFileSync(path.join(site, "index.html"), "<h1>hi</h1>")
  fs.writeFileSync(path.join(site, "assets", "app.js"), "1")
  return site
}

const rejects = (promise: Promise<unknown>, message: RegExp) => assert.rejects(promise, (error) => error instanceof ArtifactError && message.test(error.message))
const key = (url: string) => decodeURIComponent(url.slice(PUBLIC.length))

test("names are kebab case, without accents or symbols", () => {
  assert.equal(kebab("  Checkout, After (v2) "), "checkout-after-v2")
  assert.equal(kebab("Café_Joyería"), "cafe-joyeria")
  assert.equal(kebab("日本"), "")
})

test("files go under the task, the project's month, or the month, with a random ending", async () => {
  const { work, objects, context } = setup()
  fs.writeFileSync(path.join(work, "Shot One.PNG"), "png")
  const loose = await publish({ source: path.join(work, "Shot One.PNG") }, context)
  assert.match(key(loose.url), /^2026-11\/shot-one-[0-9a-f]{6}\.png$/u)
  assert.deepEqual({ ...loose, url: undefined }, { url: undefined, project: null, task: null, name: "shot-one", type: "image/png", bytes: 3, files: 1, created: NOW.toISOString() })
  assert.equal(objects.get(key(loose.url))!.type, "image/png")
  const project = await publish({ source: path.join(work, "Shot One.PNG"), project: "acme", title: "Checkout after.png" }, context)
  assert.match(key(project.url), /^acme\/2026-11\/checkout-after-[0-9a-f]{6}\.png$/u)
  const task = await publish({ source: path.join(work, "Shot One.PNG"), project: "acme", task: "TSK-123", title: "Checkout after" }, context)
  assert.match(key(task.url), /^acme\/tsk-123\/checkout-after-[0-9a-f]{6}\.png$/u)
  assert.equal(task.task, "tsk-123")
  const again = await publish({ source: path.join(work, "Shot One.PNG"), project: "acme", task: "TSK-123", title: "Checkout after" }, context)
  assert.notEqual(again.url, task.url, "a second publish never replaces the first")
})

test("a folder is a page: its files go under one folder, and the link opens its index.html", async () => {
  const { work, objects, context } = setup()
  const published = await publish({ source: page(work, "report"), project: "acme", task: "tsk-7", title: "Q4 Report" }, context)
  assert.match(key(published.url), /^acme\/tsk-7\/q4-report-[0-9a-f]{6}\/index\.html$/u)
  assert.deepEqual([published.name, published.files, published.bytes], ["q4-report", 2, 12])
  assert.match(published.type, /^text\/html/u)
  const folder = key(published.url).replace(/index\.html$/u, "")
  assert.deepEqual([...objects.keys()].sort(), [`${folder}assets/app.js`, `${folder}index.html`])
  assert.match(objects.get(`${folder}assets/app.js`)!.type, /javascript/u)
  assert.ok(objects.get(`${folder}index.html`)!.modified > objects.get(`${folder}assets/app.js`)!.modified, "index.html goes up last")
})

test("what must not go public by accident is refused before anything is written", async () => {
  const { work, objects, context } = setup()
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
  await rejects(publish({ source: path.join(work, "a.png"), task: "TSK-1" }, context), /--task needs --project/u)
  await rejects(publish({ source: path.join(work, "a.png"), project: "acme", task: "https://app.notion.com/p/x" }, context), /not a task ID/u)
  await rejects(publish({ source: path.join(work, "a.png"), title: "日本" }, context), /no letters or digits/u)
  await rejects(publish({ source: path.join(work, "a.png") }, { ...context, config: EMPTY_CONFIG }), /no bucket configured/u)
  assert.equal(objects.size, 0)
})

test("a publish that fails partway takes back what went up", async () => {
  const { work, objects, bucket, context } = setup()
  const site = page(work, "site")
  let writes = 0
  const failing: Bucket = { ...bucket, write: (key, body, type) => (++writes === 2 ? Promise.reject(new Error("503 Slow Down")) : bucket.write(key, body, type)) }
  await rejects(publish({ source: site }, { ...context, bucket: failing }), /503 Slow Down; nothing was left public/u)
  assert.equal(objects.size, 0)
  writes = 0
  const stuck: Bucket = { ...failing, delete: () => Promise.reject(new Error("offline")) }
  await rejects(publish({ source: site }, { ...context, bucket: stuck }), /still public: https:\/\/files\.example\.test\/2026-11\/site-[0-9a-f]{6}\/assets\/app\.js$/u)
})

test("list finds a project's or a task's artifacts by their folders, newest first, and by words in the name", async () => {
  const { work, objects, bucket, context } = setup()
  fs.writeFileSync(path.join(work, "a.png"), "x")
  const loose = await publish({ source: path.join(work, "a.png"), title: "Homepage hero" }, context)
  const month = await publish({ source: path.join(work, "a.png"), project: "acme", title: "Homepage before" }, context)
  const report = await publish({ source: page(work, "report"), project: "acme", task: "TSK-9", title: "Checkout report" }, context)
  objects.set("uploads/2026-11/0123456789abcdef/other.png", { text: "x", type: "image/png", modified: NOW.toISOString() })
  objects.set("acme/2026-11/no-random-part.png", { text: "x", type: "image/png", modified: NOW.toISOString() })
  const urls = (found: { artifacts: { url: string }[] }) => found.artifacts.map((artifact) => artifact.url)
  const all = await list({}, { config: CONFIG, bucket })
  assert.deepEqual(urls(all), [report.url, month.url, loose.url], "only the layout's artifacts, newest first")
  assert.deepEqual(all.artifacts[0], { ...report, created: all.artifacts[0]!.created })
  assert.deepEqual(urls(await list({ project: "acme" }, { config: CONFIG, bucket })), [report.url, month.url])
  assert.deepEqual(urls(await list({ project: "acme", task: "tsk-9" }, { config: CONFIG, bucket })), [report.url])
  assert.deepEqual(urls(await list({ search: "Homepage" }, { config: CONFIG, bucket })), [month.url, loose.url])
  assert.deepEqual(urls(await list({ search: "homepage acme" }, { config: CONFIG, bucket })), [month.url])
  assert.deepEqual(await list({ limit: 1 }, { config: CONFIG, bucket }).then((found) => [urls(found), found.total]), [[report.url], 3])
  objects.delete(key(report.url))
  assert.deepEqual(urls(await list({ project: "acme", task: "TSK-9" }, { config: CONFIG, bucket })), [], "a page without its index.html has no link")
  await rejects(list({ task: "TSK-9" }, { config: CONFIG, bucket }), /--task needs --project/u)
  await rejects(list({}, { config: CONFIG, bucket: { ...bucket, list: () => Promise.reject(new Error("offline")) } }), /refused the list: offline/u)
})

test("delete removes one artifact by its link, and refuses anything else", async () => {
  const { work, objects, bucket, context } = setup()
  fs.writeFileSync(path.join(work, "a.png"), "x")
  const kept = await publish({ source: path.join(work, "a.png"), project: "acme" }, context)
  const gone = await publish({ source: path.join(work, "a.png"), project: "acme" }, context)
  const site = await publish({ source: page(work, "report"), project: "acme", task: "TSK-1" }, context)
  objects.set("uploads/2026-11/0123456789abcdef/other.png", { text: "x", type: "image/png", modified: NOW.toISOString() })
  assert.deepEqual(await remove(gone.url, { config: CONFIG, bucket }), { url: gone.url, deleted: 1 })
  assert.deepEqual(await remove(site.url, { config: CONFIG, bucket }), { url: site.url, deleted: 2 })
  assert.deepEqual([...objects.keys()].sort(), [key(kept.url), "uploads/2026-11/0123456789abcdef/other.png"])
  await rejects(remove(gone.url, { config: CONFIG, bucket }), /already deleted/u)
  await rejects(remove(`${PUBLIC}uploads/2026-11/0123456789abcdef/other.png`, { config: CONFIG, bucket }), /not an artifact's link/u)
  await rejects(remove("https://elsewhere.test/2026-11/a-abcdef.png", { config: CONFIG, bucket }), /not in the artifacts bucket/u)
  await rejects(remove(`${PUBLIC}2026-11/a-abcdef.png`, { config: CONFIG, bucket: { ...bucket, list: () => Promise.reject(new Error("offline")) } }), /refused the delete: offline/u)
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
