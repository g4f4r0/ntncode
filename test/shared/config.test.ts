import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import path from "node:path"
import { EMPTY_CONFIG, readConfig, readToken, withConfig } from "../../src/shared/config.ts"
import { tempHome } from "../helpers.ts"

const OWNER = "5f6e7d8c-9b0a-4f1e-8d2c-3b4a5f6e7d8c"

test("a missing config is the default; a valid one is read", () => {
  const paths = tempHome()
  assert.deepEqual(readConfig(paths.config), EMPTY_CONFIG)
  fs.writeFileSync(paths.config, JSON.stringify({ assignee: OWNER }))
  assert.deepEqual(readConfig(paths.config), { ...EMPTY_CONFIG, assignee: OWNER })
  const full = { assignee: OWNER.replaceAll("-", "").toUpperCase(), skills: OWNER, automations: { automations: OWNER, runs: OWNER }, onFailure: "~/alert.sh", mcp: ["notion", "executor"] }
  fs.writeFileSync(paths.config, JSON.stringify(full))
  assert.deepEqual(readConfig(paths.config), { ...EMPTY_CONFIG, assignee: OWNER, skills: OWNER, automations: { automations: OWNER, runs: OWNER, instructions: null }, onFailure: "~/alert.sh", mcp: ["notion", "executor"] })
})

test("an unknown key, a bad assignee, or broken JSON is an error, never ignored", () => {
  const paths = tempHome()
  for (const content of [JSON.stringify({ assignee: OWNER, ownr: "x" }), JSON.stringify({ assignee: "Johan" }), JSON.stringify({ projects: "code" }), JSON.stringify({ automations: { automations: OWNER } }), JSON.stringify({ automations: { automations: OWNER, runs: OWNER, extra: 1 } }), JSON.stringify({ mcp: ["no spaces"] }), JSON.stringify({ onFailure: "" }), "{ nope", "[]"]) {
    fs.writeFileSync(paths.config, content)
    assert.throws(() => readConfig(paths.config))
  }
})

test("the token comes from the environment first, then the secrets file", () => {
  const paths = tempHome()
  const saved = process.env.NOTION_ACCESS_TOKEN
  try {
    delete process.env.NOTION_ACCESS_TOKEN
    assert.equal(readToken(paths.secrets), null)
    fs.writeFileSync(paths.secrets, 'OTHER=1\nexport NOTION_ACCESS_TOKEN="ntn_file"\n')
    assert.equal(readToken(paths.secrets), "ntn_file")
    process.env.NOTION_ACCESS_TOKEN = "ntn_env"
    assert.equal(readToken(paths.secrets), "ntn_env")
  } finally {
    if (saved === undefined) delete process.env.NOTION_ACCESS_TOKEN
    else process.env.NOTION_ACCESS_TOKEN = saved
  }
})

test("the artifacts bucket needs an S3 URL with the bucket, and a public URL", () => {
  const paths = tempHome()
  fs.writeFileSync(paths.config, JSON.stringify({ artifacts: { bucketUrl: "https://s3.example.test/bucket/", publicUrl: "https://files.example.test/" } }))
  assert.deepEqual(readConfig(paths.config).artifacts, { bucketUrl: "https://s3.example.test/bucket", publicUrl: "https://files.example.test" })
  for (const artifacts of [{ bucketUrl: "https://s3.example.test", publicUrl: "https://f.test" }, { bucketUrl: "https://s3.example.test/a/b", publicUrl: "https://f.test" }, { bucketUrl: "https://s3.example.test/b", publicUrl: "ftp://f.test" }, { bucketUrl: "https://s3.example.test/b" }, { bucketUrl: "https://s3.example.test/b", publicUrl: "https://f.test", prefix: "x" }]) {
    fs.writeFileSync(paths.config, JSON.stringify({ artifacts }))
    assert.throws(() => readConfig(paths.config))
  }
})

test("a projects folder in the config replaces ~/projects", () => {
  const paths = tempHome()
  assert.equal(withConfig(paths, EMPTY_CONFIG).projects, paths.projects)
  assert.equal(withConfig(paths, { ...EMPTY_CONFIG, projects: "~/code" }).projects, path.join(paths.home, "code"))
  assert.equal(withConfig(paths, { ...EMPTY_CONFIG, projects: "/srv/work" }).projects, "/srv/work")
})
