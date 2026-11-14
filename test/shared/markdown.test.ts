import assert from "node:assert/strict"
import { test } from "node:test"
import { normalizeNotionMarkdown } from "../../src/shared/markdown.ts"

const plain = (markdown: string) => normalizeNotionMarkdown(markdown).trimEnd()

test("Notion's autolinks and escapes of plain text are undone, so commands and names reach the agent as written", () => {
  assert.equal(plain("Read /x/[PROCEDURE.md](http://PROCEDURE.md) and [extract.py](http://extract.py)"), "Read /x/PROCEDURE.md and extract.py")
  assert.equal(plain("npx shopify theme publish --store [acme-store.myshopify.com](http://acme-store.myshopify.com) --theme \\<id> --force"), "npx shopify theme publish --store acme-store.myshopify.com --theme <id> --force")
  assert.equal(plain("tools.shopify.mutation\\_pageUpdate, America/New\\_York, \\*.liquid, a \\\\ b"), "tools.shopify.mutation_pageUpdate, America/New_York, *.liquid, a \\ b")
  assert.equal(plain("Write to [info@x.com](mailto:info@x.com) or [https://x.com](https://x.com)"), "Write to info@x.com or https://x.com")
  assert.equal(plain("Tasks data source <collection://0d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a>; see <https://x.com/a>"), "Tasks data source collection://0d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a; see https://x.com/a")
})

test("real links, page mentions and code are left alone", () => {
  assert.equal(plain("See [the docs](https://x.com/docs) and [Task](https://app.notion.com/p/abc)"), "See [the docs](https://x.com/docs) and [Task](https://app.notion.com/p/abc)")
  assert.equal(plain("Run `a\\_b [x.md](http://x.md)` now"), "Run `a\\_b [x.md](http://x.md)` now")
  assert.equal(plain("```\nmy\\_var [a.md](http://a.md)\n```"), "```\nmy\\_var [a.md](http://a.md)\n```")
})

test("a list item's inner paragraphs lose their <p> markup and keep their text and indent", () => {
  assert.equal(plain("1. Run exactly:\n   <p>\n   infisical run -- python3 x.py\n   </p>\n\n   <p>\n   It ends with OK.\n   </p>\n2. Next"), "1. Run exactly:\n   infisical run -- python3 x.py\n\n   It ends with OK.\n2. Next")
})
