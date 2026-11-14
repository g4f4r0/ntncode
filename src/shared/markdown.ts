const fencePattern = /^\s{0,3}(`{3,}|~{3,})/u
const emptyBlockPattern = /^\s*<(?:empty-block|p)\s*\/>\s*$/u

function toCodeSpan(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/gu) ?? []).map((run) => run.length))
  const fence = "`".repeat(longest + 1)
  const padding = code.startsWith("`") || code.endsWith("`") ? " " : ""
  return `${fence}${padding}${code}${padding}${fence}`
}

const ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu
const unescape = (text: string) => text.replace(ESCAPE, "$1")

/**
 * Notion's export of plain text, undone for agents, who read the raw text: a bare file or domain name it turned into
 * a link (`[a.md](http://a.md)`) goes back to the name, an autolink (`<https://x>`) to the address, and its markdown
 * escapes (`New\_York`, `\<id>`) to the characters. Code spans are left exactly as they are.
 */
function plainForAgents(line: string): string {
  return line
    .split(/(`+[^`]*?`+)/u)
    .map((part, index) => {
      if (index % 2 === 1) return part
      const delinked = part.replace(/\[((?:\\.|[^\]\\\n])+)\]\(([^)\s]+)\)/gu, (whole, label: string, url: string) => {
        const text = unescape(label)
        return [text, `http://${text}`, `https://${text}`, `mailto:${text}`].includes(url) ? label : whole
      })
      // An autolink, <https://…> or <collection://…>, is the bare address.
      return unescape(delinked.replace(/<([a-z][a-z0-9+.-]*:\/\/[^\s<>]+)>/gu, "$1"))
    })
    .join("")
}

function normalizeInline(line: string): string {
  return plainForAgents(
    line
      .replace(/<code>([\s\S]*?)<\/code>/gu, (_, code: string) => toCodeSpan(code))
      .replace(/<(page|database|mention)\s+[^>]*?url="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gu, (_, _tag: string, url: string, label: string) => `[${label}](${url})`)
      .replace(/<mention\s+[^>]*?url="([^"]+)"[^>]*\/>/gu, (_, url: string) => `<${url}>`)
      .replace(/<\/?(?:span|u)(?:\s[^>]*)?>/gu, ""),
  )
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

    // A paragraph inside a list item comes as indented <p> and </p> lines around its text: markup, not content.
    if (/^\s*<\/?p>\s*$/u.test(line)) continue
    push(emptyBlockPattern.test(line) ? "" : normalizeInline(line))
  }

  while (lines.at(-1) === "") lines.pop()
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}

/** Sets `disable-model-invocation: true` in a SKILL.md's frontmatter, so agents load it only when asked. */
export function disableModelInvocation(markdown: string): string {
  const match = markdown.match(/^---\n([\s\S]*?)\n---(?=\n|$)/u)
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter")
  const lines = match[1]!.split("\n")
  const index = lines.findIndex((line) => /^disable-model-invocation:/u.test(line))
  if (index === -1) lines.push("disable-model-invocation: true")
  else lines[index] = "disable-model-invocation: true"
  return `${["---", ...lines, "---"].join("\n")}${markdown.slice(match[0].length)}`
}
