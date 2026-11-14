// Notion REST client, from opencode-notion's src/notion.ts (skills calls come back with the skills sync).

export const NOTION_VERSION = "2026-03-11"

/** A failed Notion request, with the HTTP status when Notion answered. */
export class NotionError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export interface NotionPage {
  id: string
  url?: string
  in_trash?: boolean
  archived?: boolean
  last_edited_time?: string
  properties?: Record<string, NotionProperty>
}

export interface NotionProperty {
  type?: string
  title?: RichText[]
  rich_text?: RichText[]
}

interface RichText {
  plain_text?: string
  text?: { content?: string }
}

export interface NotionClientOptions {
  baseUrl?: string
  attempts?: number
  sleep?: (ms: number) => Promise<void>
  fetch?: typeof fetch
}

/** What the sync needs from Notion; tests pass a fake. */
export interface Notion {
  getPage(pageId: string): Promise<NotionPage>
  getPageMarkdown(pageId: string): Promise<string>
}

/** A Notion API client that retries rate limits, server errors and network failures. */
export function createNotion(token: string, { baseUrl = "https://api.notion.com/v1", attempts = 4, sleep, fetch: fetcher = fetch }: NotionClientOptions = {}): Notion {
  const wait = sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  async function request<T = unknown>(pathname: string): Promise<T> {
    let lastError: NotionError | undefined
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response: Response
      try {
        response = await fetcher(`${baseUrl}${pathname}`, {
          headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
          signal: AbortSignal.timeout(30_000),
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
          ? new NotionError("Notion page not found, or not shared with the token's owner", 404)
          : response.status === 401
            ? new NotionError("Notion rejected the token (401)", 401)
            : new NotionError(`Notion failed (${response.status}): ${body}`, response.status)
      if (response.status !== 429 && response.status < 500) throw lastError
      if (attempt < attempts - 1) {
        const retryAfter = Number(response.headers.get("retry-after"))
        await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 1_000 * 2 ** attempt)
      }
    }
    throw lastError ?? new NotionError("Notion failed")
  }

  return {
    getPage: (pageId) => request<NotionPage>(`/pages/${pageId}`),

    async getPageMarkdown(pageId) {
      const response = await request<{ markdown?: unknown; truncated?: boolean; unknown_block_ids?: string[] }>(`/pages/${pageId}/markdown?markdown_version=v2`)
      if (response.truncated) throw new NotionError("Notion's markdown export of the page is truncated")
      if (response.unknown_block_ids?.length) throw new NotionError(`${response.unknown_block_ids.length} blocks of the page could not be exported`)
      if (typeof response.markdown !== "string") throw new NotionError("Notion returned no markdown for the page")
      return response.markdown
    },
  }
}

/** The page's title property, trimmed. */
export function getTitle(page: NotionPage): string {
  const title = Object.values(page.properties ?? {}).find((property) => property.type === "title")
  return (title?.title ?? []).map((part) => part.plain_text ?? part.text?.content ?? "").join("").trim()
}
