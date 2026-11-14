# Notion Code

Notion Code makes Notion the source of truth for every coding agent. You keep instructions, skills and scheduled
automations in Notion, and every agent on the machine works from them: Claude Code, Codex, OpenCode, or the next one
you switch to. Change the agent and keep the same quality.

Notion Code is an independent open-source project. It isn't made by or affiliated with Notion Labs. Its command is
`ntncode`, a nod to Notion's own CLI, `ntn`. It is written for agents first: every command prints one JSON document.

## What it does

1. Instructions: it copies each Notion Instructions page into the `AGENTS.md` file every agent reads.
2. Skills: it copies the Notion Skills library into `~/.agents/skills`, one folder per skill.
3. Agents: it links each agent's own paths into `~/.agents`, so there is one copy of everything, and `ntncode doctor`
   checks that every agent has its MCP servers configured and signed in.
4. Automations: it runs the rows of a Notion Automations database on their schedules, on the agent each row names, and
   records every run in Notion.
5. Artifacts: `ntncode artifact publish` puts a file or a small web page in a public bucket and returns a link that
   never expires, for a Notion comment, a pull request or a client message. `ntncode artifact list` finds them again.

`ntncode serve` does all of it: every sync every 10 minutes, and every automation on its schedule. The syncs only read
from Notion. Only the automations runner writes to Notion, and only to its Runs.

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

It checks only folders directly under the projects folder. That folder is `~/projects` unless you set `projects` in
the config.

Notion's markdown export escapes plain text and turns bare file and domain names into links (`[a.md](http://a.md)`).
The sync undoes both outside code, so a command in Notion reaches the agent exactly as written.

## How skills work

With `skills` set in the config, each sync exports every skill in the Notion Skills data source through Notion's Agent
Skills API and writes it to `~/.agents/skills/<name>`. A skill with Auto-invoke unticked gets
`disable-model-invocation: true`, so agents load it only when asked.

It writes a folder only when Notion Code wrote it before, or nothing is there. A folder that already matches Notion
exactly is adopted as it is; anything else is left alone and reported. A skill removed from Notion moves to the
backups, unless it was edited by hand. When any Notion read fails, every skill stays as it is.

## Links each agent needs

| Link | Points to | Why |
| --- | --- | --- |
| `~/.claude/CLAUDE.md` | `../.agents/AGENTS.md` | Claude Code's global instructions file |
| `~/.claude/skills` | `../.agents/skills` | Claude Code doesn't read `~/.agents/skills`; Codex and OpenCode do |
| `~/.codex/AGENTS.md` | `../.agents/AGENTS.md` | Codex's global instructions file |
| `~/.config/opencode/AGENTS.md` | `../../.agents/AGENTS.md` | OpenCode's global instructions file. Made only once opencode-notion is gone, which adds the same text itself |

The sync makes a link only when nothing is at that path yet. Whatever is already there, it leaves alone and reports.

Codex also needs one line in `~/.codex/config.toml`, at the top, before any `[table]`:

```toml
project_root_markers = ["notion.json"]
```

Without it, Codex reads a project folder's `AGENTS.md` only when a chat opens in that folder itself, not in a
repository inside it.

## How automations work

An automation is a row in a Notion database with two data sources: Automations, one row per automation, and Runs,
which only Notion Code writes.

| Automations property | Type | Holds |
| --- | --- | --- |
| ID | Unique ID, prefix `AUT` | Set by Notion |
| Title | Title | What it does |
| Assignee | Person | Who it runs for: each installation runs only the automations assigned to its `assignee`. One person per row, so two installations never race for the same run |
| Project | Relation to a Projects database with a `Folder` text property | The agent runs in `~/projects/<Folder>`; empty runs it in the state's `workspace` folder |
| Status | Status: `Disabled`, `Enabled` | Only `Enabled` runs |
| Agent | Select: `Claude Code`, `Codex`, `OpenCode` | The agent that runs it |
| Model, Effort | Select, such as `Opus 5.5` or `GPT-6.1 Sol`; select `Low` to `Max` | Optional; empty uses the agent's default. `Opus 5.5` runs as `claude-opus-5-5` and `GPT-6.1 Sol` as `gpt-6.1-sol`; any other option is passed as the model ID. OpenCode gets `anthropic/` or `openai/` added |
| Start, Time zone, Repeat, Every, Days, Days of month, Months, Hours, Minutes, Occurrence, Limit, Until | Date; select; select; number; multi-selects; number; date | The schedule, one property per part of an iCalendar recurrence rule |
| Runs | Relation to Runs | Every run, newest last |
| Page body | | The prompt |

| Runs property | Type | Holds |
| --- | --- | --- |
| ID | Unique ID, prefix `RUN` | Set by Notion |
| Title | Title | `AUT-12@2026-11-20T08:00Z`: the automation and the minute it was scheduled for, or started by hand |
| Automation | Relation, two-way with Automations' Runs | |
| Trigger | Select: `Scheduled`, `Manual` | |
| Status | Status: `In progress`, `Completed`, `Failed` | |
| Date | Date range | From start to finish |
| Duration, Cost, Input tokens, Cached tokens, Output tokens | Numbers | Seconds, the agent's cost estimate, and its token counts, exact, for views that sum or chart them; empty when the agent reports none |
| Page body | | `## Details`, the same table every time, with no header row (Agent, Model, Effort, Trigger, Duration, Cost, Tokens, Session, Folder), and `## Result`, the agent's final reply or the error |

`ntncode doctor` checks that both data sources have every property, with the right type and options.

The schedule properties are strict. Start, Time zone and Repeat are required. Notion keeps only a date's offset, not its
zone, so Time zone is what keeps a daily 08:00 run at 08:00 across daylight-saving changes. `Once` takes no other
schedule property, Limit and Until don't mix, and an invalid row is reported, never guessed at. The recurrence engine
matches python-dateutil on every tested case.

What makes an automation run:

1. Its Assignee is this installation's `assignee`, and the assignee made the row's last edit. Property edits made
   through the API show as the token's bot, so they never count. Notion credits a page body edit made through its
   markdown API to the token's owner, though, so the check can't tell those from the assignee's own; that's why agent
   runs never get Notion Code's token. Setting
   `Disabled` always takes effect, whoever does it.
2. Each accepted row becomes an automation file in the state folder, and the scheduler reads those files, not Notion.
3. A scheduled run first looks for its Title in Runs, so the same scheduled minute never runs twice, even if the state
   is lost.
4. Occurrences missed while the scheduler was down collapse into one run, the latest. A row never runs for times
   before it was first accepted.
5. Two runs of the same automation never overlap; an occurrence that comes while one is running is skipped.

Each run is a fresh, unattended session: Claude Code with `--permission-mode bypassPermissions`, Codex with
`--dangerously-bypass-approvals-and-sandbox`, OpenCode with `--auto`. Its prompt wraps the row's body with what started
the run (`<trigger scheduled_for started_at time_zone>`), the folder, the instructions page every run gets, and the
reports of the automation's three latest runs, so no run depends on an earlier session.

When a run fails, or is cut off because the scheduler stopped, it is marked `Failed` and the config's `onFailure`
command runs with the details on stdin and in `AUTOMATION_*` variables. An agent can raise an alarm during a run with
`ntncode alert "<message>"`, which goes through the same command. A Runs update Notion refuses waits in an outbox and
is retried every tick.

## How artifacts work

Any agent with a shell publishes, finds and deletes artifacts the same way:

```sh
ntncode artifact publish ./screenshot.png --title "Checkout after redesign" --project acme --task TSK-123
ntncode artifact publish ./report        # a folder with an index.html is a page
ntncode artifact list --project acme --search checkout
ntncode artifact delete <url>
```

`publish` prints the link as `url`. The link never expires, and a browser shows the file, because it keeps its type. A
folder needs an `index.html` at its top, and the link opens it. Every flag is optional, but `--task` needs
`--project`. `--project` must be a folder under the projects folder, and `--task` is the Notion task's ID.

The bucket is the index, and nothing is written to Notion. Where a file sits says what it belongs to:

| Flags | Where it goes |
| --- | --- |
| `--project acme --task TSK-123` | `acme/tsk-123/checkout-after-redesign-7f3a9c.png` |
| `--project acme` | `acme/2026-11/checkout-after-redesign-7f3a9c.png` |
| none | `2026-11/checkout-after-redesign-7f3a9c.png` |

The name is `--title`, or the file's own name, in kebab case. A page gets a folder of that name. The random ending
keeps links unguessable and stops one publish from replacing another; to change a page, publish it again and use the
new link. `list` reads only the folder a project or task names, and `--search` matches words in the name, so a
descriptive title is what makes an artifact easy to find later.

The bucket is Cloudflare R2, or another S3-compatible store that serves its objects publicly and accepts the signing
region `auto`; AWS S3 doesn't. Anyone with a link can open it, so never publish secrets or private data. To protect a
folder, `publish` refuses dot-files, such as `.env`, and symbolic links, and stops at 100 MiB. A publish that fails
partway removes what it uploaded. `delete` removes one artifact, every file of a page, and refuses anything outside
this layout.

## Install

You need [Bun](https://bun.sh) 1.4 or later. It runs the TypeScript directly, so there's no build step.

1. Clone the repository anywhere, install its dependencies, and put the command on your PATH. The examples use
   `~/src/notion-code`:

   ```sh
   git clone https://github.com/g4f4r0/notion-code.git ~/src/notion-code
   cd ~/src/notion-code && bun install
   ln -s ~/src/notion-code/bin/ntncode ~/.local/bin/ntncode
   ```

2. Create a personal access token in Notion's [developer portal](https://www.notion.so/developers/tokens) with the
   Notion API capability, in the workspace that holds your pages. Share the Instructions pages, the Skills and
   Automations databases, and the Projects database with it. Add it to `~/.config/secrets.env`:

   ```sh
   NOTION_ACCESS_TOKEN=ntn_...
   ```

3. Write the config file, `~/.config/notion-code/config.json`. Every key is optional; leave out what you don't use:

   ```json
   {
     "assignee": "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
     "skills": "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
     "automations": {
       "automations": "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
       "runs": "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a",
       "instructions": "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b"
     },
     "onFailure": "~/.config/notion-code/alert.sh",
     "mcp": ["notion", "executor"],
     "artifacts": {
       "bucketUrl": "https://<account>.r2.cloudflarestorage.com/<bucket>",
       "publicUrl": "https://pub-<id>.r2.dev"
     }
   }
   ```

   `assignee` is your Notion user ID: `bot.owner.user.id` in
   `curl -s https://api.notion.com/v1/users/me -H "Authorization: Bearer $NOTION_ACCESS_TOKEN" -H "Notion-Version: 2026-03-11"`.

   For artifacts, add a key that can read and write only that bucket to `~/.config/secrets.env`, as
   `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.

4. Add a `notion.json` to `~/.agents` and to each project folder, then check what a sync would do:

   ```sh
   ntncode sync --dry-run
   ```

5. Give the agents what they need to sign in unattended. A systemd service doesn't read your shell profile, so a key
   your profile exports, such as `ANTHROPIC_AUTH_TOKEN` for a proxy, goes in `~/.config/notion-code/agents.env`
   (mode 600), as `NAME=value` lines. `ntncode doctor` names any that are missing.

6. Start the scheduler:

   ```sh
   ln -s ~/src/notion-code/systemd/ntncode.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now ntncode.service
   ```

   On a server, run `loginctl enable-linger $USER` once, or the scheduler stops when you log out.

7. Run `ntncode doctor` until it reports no errors.

## Commands

Every command prints one JSON document on stdout; `ntncode help` describes them all, with what each prints.

| Command | What it does |
| --- | --- |
| `ntncode sync [--dry-run] [--only <module>]` | Runs every sync once now. A dry run reads Notion and writes nothing, not even its own state |
| `ntncode doctor` | Checks the token, the config, both databases' properties, every link, every agent's MCP servers and sign-in, the scheduler, and every automation with its next three runs |
| `ntncode serve` | The scheduler, run by `ntncode.service`. One JSON line per event, also in `serve.log` |
| `ntncode run AUT-12 [--wait]` | Starts one run now, read fresh from Notion, even while the row is `Disabled`, for a rehearsal. Needs the scheduler running |
| `ntncode alert "<message>"` | From inside a run: asks a person for attention through `onFailure` |
| `ntncode artifact publish <file\|folder> [--title] [--project [--task]]` | Publishes a file, or a folder as a page, and prints its public link |
| `ntncode artifact list [--project [--task]] [--search] [--limit]` | Finds published artifacts, newest first |
| `ntncode artifact delete <url>` | Deletes one artifact |
| `ntncode status` | The scheduler, the runs in progress, and each automation's last and next runs, from local files only |
| `ntncode help` | The commands, the exit codes and the files, as JSON |

| Exit code | Meaning |
| --- | --- |
| `0` | Done, and nothing needs attention |
| `1` | Something needs attention: a failed or skipped result, a `doctor` error, or a failed run |
| `2` | Usage: bad arguments, no token, or an invalid config |

Every error has a `message`, and `doctor` adds a `fix` to each failed check.

## Configuration

| Setting | Where | Default | Effect |
| --- | --- | --- | --- |
| `NOTION_ACCESS_TOKEN` | environment, else `~/.config/secrets.env` | none | The Notion token |
| `assignee` | config | none | The Notion user this installation runs automations for |
| `projects` | config | `~/projects` | The folder whose direct children may hold a `notion.json`, and where project automations run |
| `skills` | config | off | The Notion Skills data source |
| `automations` | config | off | The Automations and Runs data sources, and the instructions page every run gets |
| `onFailure` | config | none | A shell command run when a run fails, or an agent calls `ntncode alert` |
| `mcp` | config | `["notion"]` | The MCP servers every installed agent must have, signed in |
| `artifacts` | config | off | The public bucket: `bucketUrl`, its S3 endpoint and bucket name, and `publicUrl`, where it is served |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | environment, else `~/.config/secrets.env` | none | The bucket's access key |
| `XDG_STATE_HOME`, `XDG_CONFIG_HOME` | environment | `~/.local/state`, `~/.config` | Where the state and config folders go |

The config is validated with Zod: an unknown key, a malformed ID or a bad path is an error that names the key, never
ignored. `notion.json`, every state file and every automation file are validated the same way.

## Safety rules

1. The syncs only read from Notion. Only the runner writes, and only to Runs; `test/architecture.test.ts` fails the
   build if anything else imports the Notion writer.
2. It writes only the `AGENTS.md` beside a `notion.json`, and never one without its `<!-- Synced from Notion` first line.
3. It never writes through a link, and never replaces a skill folder it didn't write unless it already matches Notion.
4. A hand edit to a synced file or skill is copied to `backups/<time>/` in the state folder before it's replaced.
5. It finishes every Notion read before writing anything; when Notion fails, everything keeps its last good copy.
6. It writes each file to a temporary name and renames it, so no agent reads half a file.
7. One sync runs at a time, with `flock`, and one scheduler.
8. An automation runs only for its assignee, only after the assignee's own edit, never twice for one scheduled minute, and
   never twice at once.

## Speed and Notion's limits

An unchanged page or row costs one request. The sync reads a page's markdown only when its `last_edited_time` has
moved. Notion rounds that time down to the minute, so a page read within two minutes of its last edit is read again
next time, and a second edit in the same minute isn't missed. The client retries rate limits (honouring
`retry-after`), conflicts, server errors and network failures up to four times.

## State and logs

Everything lives in `~/.local/state/notion-code/`.

| Path | Contents |
| --- | --- |
| `state.json`, `skills.json` | What each sync wrote, with hashes, so hand edits are noticed |
| `scheduler.json` | Each task's last fired occurrence, and the scheduler's heartbeat |
| `automations/` | One file per accepted automation, the instructions every run gets, manual requests and results |
| `runs/` | Runs in progress; one left by a stopped scheduler is marked Failed on the next start |
| `outbox/` | Runs updates waiting for Notion |
| `workspace/` | Where automations without a project run |
| `serve.log`, `sync.log`, `last-run.json` | The scheduler's events, each manual sync, and the latest manual sync's results |
| `backups/` | Copies of anything replaced or removed |

The scheduler's output also goes to the journal: `journalctl --user -u ntncode`.

## How the code is organised

Each domain is a module: the tasks it runs and the checks `doctor` makes.

```
src/
├── cli.ts           the commands, JSON in and out
├── modules.ts       every module, in the order their syncs run
├── shared/          Notion client and writer, files, markdown, processes, config, and the Module and Task types
├── instructions/    notion.json → AGENTS.md
├── skills/          the Notion Skills library → ~/.agents/skills
├── agents/          Claude Code, Codex and OpenCode: their links, MCP checks, sign-in needs, and how to run one prompt
├── scheduler/       the recurrence engine and the scheduler loop
├── automations/     rows → automation files, the runner, and Runs
└── artifacts/       files → the public bucket, and their links
```

A task has an ID such as `instructions.sync` or `AUT-12`, a kind (`sync` or `run`) and a schedule in iCalendar text. A
domain imports only `shared` and the domains `test/architecture.test.ts` allows it.

```sh
bun install
bun test
bun run typecheck
```

The Notion client, the markdown conversion and the skill export are adapted from opencode-notion, under its MIT
license; its notice is kept in `LICENSE`. `scripts/rrule-fixtures.py` regenerates the recurrence tests from
python-dateutil.

## Known limits

1. Codex finds a project's root by the nearest `notion.json`. For a repository outside your projects, opened in a
   subfolder, Codex reads only that subfolder's `AGENTS.md`.
2. Agents read instructions when a session starts. An edit reaches new sessions, not ones already running.
3. An OpenCode run starts a private OpenCode (`--standalone`), because OpenCode's background service ignores the
   caller's folder. It refuses while the `opencode-automations` plugin is configured, which has no lock and could fire
   its own automations a second time.
4. There is no webhook trigger; automations run on schedules or by hand.
5. On some Linux servers, Codex's sandbox can't run shell commands at all (`bwrap: loopback: Failed RTM_NEWADDR`).
   There, Codex needs full access to run `ntncode artifact`.
6. Cloudflare rate-limits a bucket's `r2.dev` address and calls it a development address. A custom domain lifts that;
   only `publicUrl` changes.

## Roadmap

1. Memory: Notion as every agent's long-term memory.
2. Webhook triggers for automations.
