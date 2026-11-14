# notion-agents

notion-agents copies Notion pages into the `AGENTS.md` files that coding agents read. Edit a page in Notion, and the
next sync puts it in front of Claude Code, Codex, OpenCode, or any other harness that reads `AGENTS.md`. It doesn't
need any of them installed or running.

It only reads from Notion and never writes to it. Notion stays the one place you edit.

## How it works

A folder opts in with a `notion.json` that names one Notion page:

```json
{ "instructions": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }
```

Each sync writes that page, as plain markdown, to the `AGENTS.md` beside the `notion.json`. One page, one file.

The sync looks in exactly two places, and nowhere else:

| `notion.json` | Writes | Read by |
| --- | --- | --- |
| `~/.agents/notion.json` | `~/.agents/AGENTS.md` | every session, through the links below |
| `~/projects/<folder>/notion.json` | `~/projects/<folder>/AGENTS.md` | sessions in that folder or any folder inside it |

It only checks folders directly under `~/projects`, not anything deeper.

It also creates three links, so every harness reads the same files and you never keep two copies in step:

| Link | Points to | Why |
| --- | --- | --- |
| `~/.claude/CLAUDE.md` | `../.agents/AGENTS.md` | Claude Code's global instructions file |
| `~/.codex/AGENTS.md` | `../.agents/AGENTS.md` | Codex's global instructions file |
| `~/.claude/skills` | `../.agents/skills` | Claude Code doesn't read `~/.agents/skills`; Codex and OpenCode do |

The sync makes a link only when nothing is at that path yet. Whatever is already there, it leaves alone and reports.

## Install

You need Node 24 or later, which runs the TypeScript directly. There's no build step and no runtime dependency.

1. Clone the repository and put the command on your PATH:

   ```sh
   git clone https://github.com/g4f4r0/notion-agents.git ~/projects/g4f4r0/notion-agents
   ln -s ~/projects/g4f4r0/notion-agents/bin/notion-agents ~/.local/bin/notion-agents
   ```

2. Create a personal access token in Notion's [developer portal](https://www.notion.so/developers/tokens) with the
   Notion API capability, in the workspace that holds your instruction pages. It acts as you, so it sees every page
   you can see. Add it to `~/.config/secrets.env`:

   ```sh
   NOTION_ACCESS_TOKEN=ntn_...
   ```

3. Add a `notion.json` to `~/.agents` and to each project folder, then check what a sync would do:

   ```sh
   notion-agents sync --dry-run
   notion-agents sync
   ```

4. Tell Codex that a folder with a `notion.json` is a project's root. Without this, Codex skips the project's
   `AGENTS.md` when a chat opens inside one of its repos. Put it at the top of `~/.codex/config.toml`, before any
   `[table]`:

   ```toml
   project_root_markers = ["notion.json"]
   ```

5. Start the timer, which syncs every 10 minutes:

   ```sh
   ln -s ~/projects/g4f4r0/notion-agents/systemd/notion-agents-sync.service ~/.config/systemd/user/
   ln -s ~/projects/g4f4r0/notion-agents/systemd/notion-agents-sync.timer ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now notion-agents-sync.timer
   ```

   On a server, run `loginctl enable-linger $USER` once, or the timer stops when you log out.

## Commands

| Command | What it does |
| --- | --- |
| `notion-agents sync` | Writes every mapped page to its `AGENTS.md` and creates any missing links |
| `notion-agents sync --dry-run` | Reads Notion and prints what a sync would do. It writes nothing, not even its own state |
| `notion-agents help` | Prints the usage |

Each run prints one line per file and a summary:

```text
written    ~/projects/acme/AGENTS.md  new file
unchanged  ~/.agents/AGENTS.md  Notion "Organization" not edited since the last sync
skipped    ~/projects/other/AGENTS.md  written by hand (no "<!-- Synced from Notion" first line); left as it is
linked     ~/.claude/skills  → /home/you/.agents/skills
2026-11-14T12:17:20.893Z sync: 4 checked, 1 need attention
```

| Status | Meaning |
| --- | --- |
| `written` | The file is new, or the page changed in Notion |
| `unchanged` | Nothing to do |
| `skipped` | It left the file or link alone on purpose; the line says why |
| `failed` | It couldn't read the page or the `notion.json`; the file keeps its last good copy |
| `linked` | It created a missing link |
| `would write`, `would link` | What a dry run would have done |

| Exit code | Meaning |
| --- | --- |
| `0` | Everything is in place, or another sync was already running |
| `1` | At least one line is `failed` or `skipped`, or the run hit an error |
| `2` | No token, or the command was wrong |

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `NOTION_ACCESS_TOKEN` | read from `~/.config/secrets.env` | The Notion token. The environment wins over the file, and the file may use `export` and quotes |
| `XDG_STATE_HOME` | `~/.local/state` | Where the `notion-agents` state folder goes |
| `--dry-run` | off | Prints what would change and changes nothing |

`notion.json` has one key, `instructions`. It takes a page ID, with or without dashes, or a page link. In a link, the
sync ignores the `?v=` view and anything after `#`. Any other key is an error, so a typo shows up in the report and
never gets silently ignored.

## Safety rules

The sync is built so that a bad run leaves your files as they were.

- It writes only the `AGENTS.md` beside a `notion.json`. It doesn't guess anything from folder names or page titles.
- Every file it writes starts with `<!-- Synced from Notion: ... -->`. It never overwrites a file without that line,
  so an `AGENTS.md` you wrote yourself is safe.
- It never writes through a link, and never writes to something that isn't a regular file.
- If you edit a synced file by hand, it copies your version to `backups/<time>/` in the state folder before replacing
  it.
- It never deletes. Removing a `notion.json` leaves its `AGENTS.md` where it is.
- It finishes every Notion read before writing anything. If Notion fails, or a page is in the trash or empty, that
  file keeps its last good copy and the run says so.
- It writes each file to a temporary name and then renames it, so no agent ever reads half a file.
- Only one sync runs at a time, enforced with `flock` on the state folder's `lock` file. A second one exits and does
  nothing.

## Speed and Notion's limits

An unchanged page costs one request. The sync reads a page's markdown only when its `last_edited_time` has moved, so
a quiet run is a handful of small calls.

Notion rounds `last_edited_time` down to the minute. A sync that ran within two minutes of the last edit reads that
page again next time, so a second edit in the same minute isn't missed.

The client retries rate limits (honouring `retry-after`), server errors and network failures up to four times, with a
growing wait. It gives up at once on other errors, such as a missing page or a rejected token.

## State and logs

Everything lives in `~/.local/state/notion-agents/`.

| File | Contents |
| --- | --- |
| `state.json` | For each file: its page, the page's edit time, when it was checked, and a hash of what was written |
| `last-run.json` | The latest run's time and every result line |
| `sync.log` | One summary per run, plus every line that wasn't `unchanged`. It rotates to `sync.log.1` past 1 MB |
| `backups/` | Copies of synced files you edited by hand, kept before they were replaced |
| `lock` | Holds the `flock` |

The timer's output goes to the journal:

```sh
journalctl --user -u notion-agents-sync
systemctl --user list-timers notion-agents-sync.timer
```

## Everyday use

1. To change instructions, edit the page in Notion. Running sessions keep what they started with; new sessions get
   the new text after the next sync, within 10 minutes. Run `notion-agents sync` to skip the wait.
2. To add a project, create its page in Notion, then write `{ "instructions": "<page id>" }` to
   `~/projects/<folder>/notion.json`. Do this once on each machine that runs the sync.
3. To stop syncing a folder, delete its `notion.json`. Its `AGENTS.md` stays, as a normal file you can edit or remove.
4. To see what's going on, look at `notion-agents sync --dry-run` or `last-run.json`.

## Notion's tools for agents

The sync covers instructions. For agents to search and edit Notion, add Notion's hosted MCP server to each harness.
Each harness signs in to Notion and keeps its own sign-in.

```sh
claude mcp add --scope user --transport http notion https://mcp.notion.com/mcp
codex mcp add notion --url https://mcp.notion.com/mcp
codex mcp login notion
```

In Claude Code, finish the sign-in with `/mcp`, then choose `notion` and `Authenticate`. Both sign-ins return to a
listener on `127.0.0.1`. If your browser is on another machine, the last page won't load. Copy its full address and
run `curl '<address>'` on the machine running the harness.

## Known limits

- Codex looks for the nearest `notion.json` to find a project's root. For a repo outside your projects, opened in one
  of its subfolders, Codex reads only that subfolder's `AGENTS.md`, not the repo root's.
- Claude Code and Codex read instructions when a session starts. An edit reaches new sessions, not ones already
  running.
- Skills aren't synced yet. A sync of a Notion skills database into `~/.agents/skills` is planned.

## Development

```sh
npm install        # TypeScript and Node's types, for the type check only
npm test           # node --test
npm run typecheck  # tsc
```

The Notion client and the markdown conversion come from opencode-notion in
[g4f4r0/opencode-plugins](https://github.com/g4f4r0/opencode-plugins), under its MIT license.
