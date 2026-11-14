import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import { readConfig, readToken } from "../../src/shared/config.ts"
import { tempHome } from "../helpers.ts"

const OWNER = "5f6e7d8c-9b0a-4f1e-8d2c-3b4a5f6e7d8c"

test("a missing config is the default; a valid one is read", () => {
  const paths = tempHome()
  assert.deepEqual(readConfig(paths.config), { owner: null })
  fs.writeFileSync(paths.config, JSON.stringify({ owner: OWNER }))
  assert.deepEqual(readConfig(paths.config), { owner: OWNER })
})

test("an unknown key, a bad owner, or broken JSON is an error, never ignored", () => {
  const paths = tempHome()
  for (const content of [JSON.stringify({ owner: OWNER, ownr: "x" }), JSON.stringify({ owner: "Johan" }), "{ nope", "[]"]) {
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
