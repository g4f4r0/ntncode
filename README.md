# Notion Code

Notion Code makes Notion the source of truth for every coding agent. You edit instructions in Notion, and every agent
on the machine works from the same text: Claude Code, Codex, OpenCode, or the next one you switch to. Change the agent
and keep the same quality.

Notion Code is an independent open-source project. It isn't made by or affiliated with Notion Labs. Its command is
`ntncode`, a nod to Notion's own CLI, `ntn`.

## What it does today

1. It copies each Notion Instructions page into the `AGENTS.md` file every agent reads.
2. It links each agent's own global paths into `~/.agents`, so there is one copy of everything.
3. `ntncode doctor` checks that every agent really reads those files.

Skills and scheduled automations come next; see [Roadmap](#roadmap). The sync only reads from Notion and never writes
to it.

## How instructions work

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

Each agent finds the files its own way, so the sync creates these links once:

| Link | Points to | Why |
| --- | --- | --- |
| `~/.claude/CLAUDE.md` | `../.agents/AGENTS.md` | Claude Code's global instructions file |
| `~/.claude/skills` | `../.agents/skills` | Claude Code doesn't read `~/.agents/skills`; Codex and OpenCode do |
| `~/.codex/AGENTS.md` | `../.agents/AGENTS.md` | Codex's global instructions file |

It makes a link only when nothing is at that path yet. Whatever is already there, it leaves alone and reports.

Codex also needs one line in `~/.codex/config.toml`, at the top, before any `[table]`:

```toml
project_root_markers = ["notion.json"]
```

Without it, Codex reads a project folder's `AGENTS.md` only when a chat opens in that folder itself, not in a
repository inside it. `ntncode doctor` checks for it.

## Install

You need [Bun](https://bun.sh) 1.4 or later. It runs the TypeScript directly, so there's no build step.

1. Clone the repository and put the command on your PATH:

   ```sh
   git clone https://github.com/g4f4r0/notion-code.git ~/projects/g4f4r0/notion-code
   ln -s ~/projects/g4f4r0/notion-code/bin/ntncode ~/.local/bin/ntncode
   ```

2. Create a personal access token in Notion's [developer portal](https://www.notion.so/developers/tokens) with the
   Notion API capability, in the workspace that holds your instruction pages. It acts as you, so it sees every page
   you can see. Add it to `~/.config/secrets.env`:

   ```sh
   NOTION_ACCESS_TOKEN=ntn_...
   ```

3. Write the config file, `~/.config/notion-code/config.json`, naming the Notion user this installation works for:

   ```json
   { "owner": "<your Notion user ID>" }
   ```

4. Add a `notion.json` to `~/.agents` and to each project folder, then check what a sync would do:

   ```sh
   ntncode sync --dry-run
   ntncode sync
   ```

5. Add the Codex line above, then run `ntncode doctor` until every line says `ok`.

6. Start the timer, which syncs every 10 minutes:

   ```sh
   ln -s ~/projects/g4f4r0/notion-code/systemd/ntncode-sync.service ~/.config/systemd/user/
   ln -s ~/projects/g4f4r0/notion-code/systemd/ntncode-sync.timer ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now ntncode-sync.timer
   ```

   On a server, run `loginctl enable-linger $USER` once, or the timer stops when you log out.

## Commands

| Command | What it does |
| --- | --- |
| `ntncode sync` | Runs every sync now and creates any missing links |
| `ntncode sync --dry-run` | Reads Notion and prints what a sync would do. It writes nothing, not even its own state |
| `ntncode doctor` | Checks the token, the config, every link, and the Codex setting |
| `ntncode help` | Prints the usage |

A sync prints one line per file and a summary:

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
| `1` | A line is `failed` or `skipped`, a `doctor` check failed, or the run hit an error |
| `2` | No token, or the command was wrong |

## Configuration

| Setting | Where | Default | Effect |
| --- | --- | --- | --- |
| `NOTION_ACCESS_TOKEN` | environment, else `~/.config/secrets.env` | none | The Notion token. The file may use `export` and quotes |
| `owner` | `~/.config/notion-code/config.json` | none | The Notion user this installation works for. Automations will run only the owner's |
| `XDG_STATE_HOME` | environment | `~/.local/state` | Where the `notion-code` state folder goes |
| `XDG_CONFIG_HOME` | environment | `~/.config` | Where the `notion-code` config folder goes |

The config file rejects any key it doesn't know and any owner that isn't a Notion user ID, so a typo shows up as an
error instead of being ignored. `notion.json` works the same way: its one key is `instructions`, which takes a page
ID, with or without dashes, or a page link.

## Safety rules

A bad run leaves your files as they were.

1. It writes only the `AGENTS.md` beside a `notion.json`, and guesses nothing from folder names or page titles.
2. Every file it writes starts with `<!-- Synced from Notion: ... -->`. It never overwrites a file without that line,
   so an `AGENTS.md` you wrote yourself is safe.
3. It never writes through a link, and never writes to something that isn't a regular file.
4. If you edit a synced file by hand, it copies your version to `backups/<time>/` in the state folder before replacing
   it.
5. It never deletes. Removing a `notion.json` leaves its `AGENTS.md` where it is.
6. It finishes every Notion read before writing anything. If Notion fails, or a page is in the trash or empty, that
   file keeps its last good copy and the run says so.
7. It writes each file to a temporary name and then renames it, so no agent ever reads half a file.
8. Only one sync runs at a time, with `flock` on the state folder's `lock` file.

## Speed and Notion's limits

An unchanged page costs one request. The sync reads a page's markdown only when its `last_edited_time` has moved.
Notion rounds that time down to the minute, so a page synced within two minutes of its last edit is read again next
time, and a second edit in the same minute isn't missed. When Notion Code changes how it writes files, each file is
written again once, on the next sync.

The client retries rate limits (honouring `retry-after`), server errors and network failures up to four times, with a
growing wait. It gives up at once on other errors, such as a missing page or a rejected token.

## State and logs

Everything lives in `~/.local/state/notion-code/`.

| File | Contents |
| --- | --- |
| `state.json` | For each file: its page, the page's edit time, when it was checked, the format it was written in, and a hash |
| `last-run.json` | The latest run's time and every result line |
| `sync.log` | One summary per run, plus every line that wasn't `unchanged`. It rotates to `sync.log.1` past 1 MB |
| `backups/` | Copies of synced files you edited by hand, kept before they were replaced |
| `lock` | Holds the `flock` |

The timer's output goes to the journal: `journalctl --user -u ntncode-sync`.

## Everyday use

1. To change instructions, edit the page in Notion. New sessions get the new text after the next sync, within 10
   minutes; sessions already running keep what they started with. Run `ntncode sync` to skip the wait.
2. To add a project, create its page in Notion, then write `{ "instructions": "<page id>" }` to
   `~/projects/<folder>/notion.json`. Do this once on each machine.
3. To stop syncing a folder, delete its `notion.json`. Its `AGENTS.md` stays, as a normal file.

## Notion's tools for agents

The sync covers instructions. For agents to search and edit Notion, add Notion's hosted MCP server to each agent. Each
one signs in to Notion and keeps its own sign-in.

```sh
claude mcp add --scope user --transport http notion https://mcp.notion.com/mcp
codex mcp add notion --url https://mcp.notion.com/mcp
codex mcp login notion
```

In Claude Code, finish the sign-in with `/mcp`, then choose `notion` and `Authenticate`. Both sign-ins return to a
listener on `127.0.0.1`. If your browser is on another machine, the last page won't load. Copy its full address and
run `curl '<address>'` on the machine running the agent.

## How the code is organised

Each domain is a module: the tasks it runs and the checks `doctor` makes.

```
src/
├── cli.ts           the commands
├── modules.ts       every module, in the order their tasks run
├── shared/          Notion client, files, markdown, config, and the Module and Task types
├── instructions/    notion.json → AGENTS.md
└── agents/          Claude Code and Codex: where each reads its files
```

A task has an ID such as `instructions.sync` and a schedule, which is an RFC 5545 recurrence rule (`FREQ=MINUTELY;
INTERVAL=10`). A domain imports only `shared`, and `shared` imports no domain; `test/architecture.test.ts` fails the
build when an import breaks that. Adding a domain means a folder that exports one `Module`, and one line in
`src/modules.ts`.

```sh
bun install        # TypeScript and Node's types, for the type check only
bun test
bun run typecheck
```

The Notion client and the markdown conversion come from opencode-notion in
[g4f4r0/opencode-plugins](https://github.com/g4f4r0/opencode-plugins), under its MIT license.

## Roadmap

1. `skills`: the Notion Skills library to `~/.agents/skills`.
2. `scheduler`: one scheduler for every task, with `ntncode serve` replacing the timer.
3. `automations`: Notion Automations rows to scheduled agent runs, run only for the installation's owner, with each
   run recorded in Notion.

## Known limits

1. Codex looks for the nearest `notion.json` to find a project's root. For a repository outside your projects, opened
   in one of its subfolders, Codex reads only that subfolder's `AGENTS.md`, not the repository root's.
2. Agents read instructions when a session starts. An edit reaches new sessions, not ones already running.
