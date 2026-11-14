import { createRequest, type NotionClientOptions, type NotionPage } from "./notion.ts"

/**
 * Writes to Notion. Only the automations runner may import this (test/architecture.test.ts enforces it): every sync
 * stays read-only, and agents never write Runs.
 */
export interface NotionWriter {
  createPage(body: { parent: { data_source_id: string }; properties: Record<string, unknown> }): Promise<NotionPage>
  updatePage(pageId: string, body: { properties?: Record<string, unknown>; in_trash?: boolean }): Promise<NotionPage>
  /** Replaces the page's whole body with markdown. */
  replaceMarkdown(pageId: string, markdown: string): Promise<void>
}

export function createNotionWriter(token: string, options: NotionClientOptions = {}): NotionWriter {
  const request = createRequest(token, options)
  return {
    createPage: (body) => request<NotionPage>("/pages", { method: "POST", body }),
    updatePage: (pageId, body) => request<NotionPage>(`/pages/${pageId}`, { method: "PATCH", body }),
    async replaceMarkdown(pageId, markdown) {
      await request(`/pages/${pageId}/markdown`, {
        method: "PATCH",
        body: { type: "replace_content", replace_content: { new_str: markdown, allow_deleting_content: true } },
      })
    },
  }
}
