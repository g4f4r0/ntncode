// Notion REST client, adapted from opencode-notion's src/notion.ts. This one only reads; the automations runner has
// its own writer (notion-writer.ts), and test/architecture.test.ts keeps every other domain from importing it.

export const NOTION_VERSION = "2026-03-11"

/** A failed Notion request, with the HTTP status when Notion answered. */
export class NotionError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export interface NotionUser {
  object: "user"
  id: string
  type?: "person" | "bot"
  name?: string | null
  bot?: { owner?: { type?: string; user?: { id: string } } }
}

export interface NotionPage {
  id: string
  url?: string
  in_trash?: boolean
  archived?: boolean
  created_time?: string
  last_edited_time?: string
  last_edited_by?: { id: string }
  properties?: Record<string, NotionProperty>
}

/** A page property as Notion returns it; each domain validates the ones it reads with Zod. */
export interface NotionProperty {
  id?: string
  type?: string
  title?: RichText[]
  rich_text?: RichText[]
  [key: string]: unknown
}

export interface RichText {
  plain_text?: string
  text?: { content?: string }
}

export interface DataSource {
  id: string
  title?: RichText[]
  properties: Record<string, { id: string; type: string; [key: string]: unknown }>
}

export interface NotionSkill {
  id: string
  version_id?: string
  url?: string
  markdown?: string
}

export interface NotionClientOptions {
  baseUrl?: string
  attempts?: number
  sleep?: (ms: number) => Promise<void>
  fetch?: typeof fetch
}

/** Everything Notion Code reads from Notion; tests pass a fake. */
export interface Notion {
  getPage(pageId: string): Promise<NotionPage>
  getPageMarkdown(pageId: string): Promise<string>
  queryDataSource(dataSourceId: string, body?: Record<string, unknown>): Promise<NotionPage[]>
  getDataSource(dataSourceId: string): Promise<DataSource>
  /** A skill's export from Notion's Agent Skills API; null when Notion doesn't treat the page as a skill. */
  getSkill(pageId: string): Promise<NotionSkill | null>
  /** Downloads a signed skill archive. The link is Notion's own, so it carries no token. */
  download(url: string): Promise<Buffer>
  me(): Promise<NotionUser>
}

export type Request = <T = unknown>(pathname: string, init?: { method?: string; body?: unknown }) => Promise<T>

/** A Notion API request function that retries rate limits, server errors and network failures. */
export function createRequest(token: string, { baseUrl = "https://api.notion.com/v1", attempts = 4, sleep, fetch: fetcher = fetch }: NotionClientOptions = {}): Request {
  const wait = sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  return async function request<T>(pathname: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    let lastError: NotionError | undefined
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response: Response
      try {
        response = await fetcher(`${baseUrl}${pathname}`, {
          method: init.method ?? "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION,
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: AbortSignal.timeout(60_000),
        })
      } catch (error) {
        const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message
        lastError = new NotionError(`Notion unreachable (${cause})`)
        if (attempt < attempts - 1) await wait(1_000 * 2 ** attempt)
        continue
      }

      if (response.ok) return (await response.json()) as T
      const body = (await response.text()).replace(/\s+/gu, " ").slice(0, 300)
      lastError =
        response.status === 404
          ? new NotionError(`Notion ${pathname.split("?")[0]} not found, or not shared with the token's owner`, 404)
          : response.status === 401
            ? new NotionError("Notion rejected the token (401)", 401)
            : new NotionError(`Notion ${init.method ?? "GET"} ${pathname.split("?")[0]} failed (${response.status}): ${body}`, response.status)
      // A 409 is a conflict with a concurrent edit: worth another try, as Notion advises.
      if (response.status !== 429 && response.status !== 409 && response.status < 500) throw lastError
      if (attempt < attempts - 1) {
        const retryAfter = Number(response.headers.get("retry-after"))
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 1_000 * 2 ** attempt)
      }
    }
    throw lastError ?? new NotionError("Notion failed")
  }
}

export function createNotion(token: string, options: NotionClientOptions = {}): Notion {
  const request = createRequest(token, options)
  const fetcher = options.fetch ?? fetch
  const attempts = options.attempts ?? 4
  const wait = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  return {
    getPage: (pageId) => request<NotionPage>(`/pages/${pageId}`),

    async getPageMarkdown(pageId) {
      const response = await request<{ markdown?: unknown; truncated?: boolean; unknown_block_ids?: string[] }>(`/pages/${pageId}/markdown?markdown_version=v2`)
      if (response.truncated) throw new NotionError("Notion's markdown export of the page is truncated")
      if (response.unknown_block_ids?.length) throw new NotionError(`${response.unknown_block_ids.length} blocks of the page could not be exported`)
      if (typeof response.markdown !== "string") throw new NotionError("Notion returned no markdown for the page")
      return response.markdown
    },

    async queryDataSource(dataSourceId, body = {}) {
      const pages: NotionPage[] = []
      let cursor: string | undefined
      do {
        const response = await request<{ results: NotionPage[]; has_more: boolean; next_cursor?: string }>(`/data_sources/${dataSourceId}/query`, {
          method: "POST",
          body: { page_size: 100, ...body, ...(cursor ? { start_cursor: cursor } : {}) },
        })
        pages.push(...response.results)
        cursor = response.has_more ? response.next_cursor : undefined
      } while (cursor)
      return pages
    },

    getDataSource: (dataSourceId) => request<DataSource>(`/data_sources/${dataSourceId}`),

    async getSkill(pageId) {
      try {
        return await request<NotionSkill>(`/ai/skills/${pageId}`)
      } catch (error) {
        if (error instanceof NotionError && error.status === 400 && error.message.includes("is not a skill")) return null
        throw error
      }
    },

    async download(url) {
      let lastError: Error | undefined
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) })
          if (response.ok) return Buffer.from(await response.arrayBuffer())
          lastError = new NotionError(`Skill archive download failed (${response.status})`, response.status)
          if (response.status < 500 && response.status !== 429) throw lastError
        } catch (error) {
          if (error instanceof NotionError && error.status !== undefined && error.status < 500 && error.status !== 429) throw error
          lastError = error instanceof Error ? error : new Error(String(error))
        }
        if (attempt < attempts - 1) await wait(1_000 * 2 ** attempt)
      }
      throw lastError ?? new Error("Skill archive download failed")
    },

    me: () => request<NotionUser>("/users/me"),
  }
}

/** The plain text of a rich text or title property. */
export function plainText(parts: RichText[] | undefined): string {
  return (parts ?? []).map((part) => part.plain_text ?? part.text?.content ?? "").join("")
}

/** The page's title property, trimmed. */
export function getTitle(page: NotionPage): string {
  const title = Object.values(page.properties ?? {}).find((property) => property.type === "title")
  return plainText(title?.title).trim()
}
