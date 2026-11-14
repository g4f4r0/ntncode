const fencePattern = /^\s{0,3}(`{3,}|~{3,})/u
const emptyBlockPattern = /^\s*<(?:empty-block|p)\s*\/>\s*$/u

function toCodeSpan(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/gu) ?? []).map((run) => run.length))
  const fence = "`".repeat(longest + 1)
  const padding = code.startsWith("`") || code.endsWith("`") ? " " : ""
  return `${fence}${padding}${code}${padding}${fence}`
}

function normalizeInline(line: string): string {
  return line
    .replace(/<code>([\s\S]*?)<\/code>/gu, (_, code: string) => toCodeSpan(code))
    .replace(/<(page|database|mention)\s+[^>]*?url="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gu, (_, _tag: string, url: string, label: string) => `[${label}](${url})`)
    .replace(/<mention\s+[^>]*?url="([^"]+)"[^>]*\/>/gu, (_, url: string) => `<${url}>`)
    .replace(/<\/?(?:span|u)(?:\s[^>]*)?>/gu, "")
}

function isClosingFence(line: string, fence: string): boolean {
  const trimmed = line.trim()
  return trimmed.length >= fence.length && trimmed === fence[0]!.repeat(trimmed.length)
}

/** Converts Notion-flavored markdown into plain CommonMark that every harness reads the same way. */
export function normalizeNotionMarkdown(markdown: string): string {
  const lines: string[] = []
  let depth = 0
  let fence: string | null = null
  let icon = ""

  const push = (text: string, isCode = false) => {
    let content = text
    if (icon && content.trim() !== "") {
      content = `${icon} ${content}`
      icon = ""
    }
    const line = `${"> ".repeat(depth)}${content}`.trimEnd()
    if (!isCode && line === "" && (lines.length === 0 || lines.at(-1) === "")) return
    lines.push(line)
  }

  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    if (fence) {
      push(line, true)
      if (isClosingFence(line, fence)) fence = null
      continue
    }

    const opening = line.match(fencePattern)
    if (opening) {
      fence = opening[1]!
      push(line, true)
      continue
    }

    const callout = line.match(/^\s*<callout(?:\s+([^>]*))?>\s*(.*)$/u)
    if (callout) {
      if (depth === 0) push("")
      depth += 1
      icon = callout[1]?.match(/icon="([^"/]*)"/u)?.[1] ?? ""
      if (callout[2]!.trim()) push(normalizeInline(callout[2]!))
      continue
    }
    if (/^\s*<\/callout>\s*$/u.test(line)) {
      icon = ""
      depth = Math.max(0, depth - 1)
      if (depth === 0) push("")
      continue
    }

    push(emptyBlockPattern.test(line) ? "" : normalizeInline(line))
  }

  while (lines.at(-1) === "") lines.pop()
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}
