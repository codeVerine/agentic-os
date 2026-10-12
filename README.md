# agentic-os

Personal agentic OS for software development.

This repository holds `aos`, a small Node/TypeScript CLI. `aos` opens a coding agent's own interactive
interface (Claude Code, Codex, OpenCode or Pi) for the project you are in, with the agent running in a
Docker container through [Sandcastle](https://github.com/mattpocock/sandcastle) instead of directly on the
Mac. You `cd` into a project and run `aos pi` the same way you would run `pi`: the same interface, the same
model picker, the same keys.

Every launch gets its own git worktree, leased from the project's
[treehouse](https://github.com/kunchenguid/treehouse) pool, so several agents can work on one project at
once without stepping on each other's files. `aos <agent> --here` skips that and runs in the current
repository directly, the way earlier versions of `aos` always did. See "Worktrees" below.

## What runs where

- Agents run only inside the local `aos-dev:local` image (Debian bookworm, Node 24, git, gh, ripgrep, fd,
  Python, build tools, and pinned `claude`, `codex`, `opencode` and `pi` CLIs). They never run on the Mac.
- Every launch goes through Sandcastle's `interactive()` API with its Docker provider, in `head` mode: the
  project directory is bind-mounted read-write, so the agent's edits and commits land in the project on the
  Mac directly.
- The container sees the project, the project's `.git`, and that agent's own login directory from
  `~/AgenticOS/secrets/<agent>/`. It never sees the Mac's `~/.ssh`, `gh` login, `~/.claude`, `~/.codex`,
  OpenCode or Pi homes, and `aos` never reads them.
- Each launch starts its own throwaway container and removes it when the session ends: on a normal exit, when
  the agent exits non-zero, and on Ctrl-C, `SIGTERM` or a closed terminal (`SIGHUP`). `aos` finds the
  container by a per-launch mount, so it never touches another session's container. A launch whose `aos`
  process is killed with `SIGKILL`, or whose Mac loses power, cannot clean up and leaves its container
  behind; `aos doctor --clean` removes the stopped ones (see "Commands"). A launch killed while its container is still being created can also leave a container that `doctor` does not list; remove it with `docker rm`.
- Each agent logs in once, inside a container. That login is stored under `~/AgenticOS/secrets/<agent>/` and
  shared by every project, so the Mac's own agent logins are never touched, and a token refreshed in a
  container never logs the Mac's own tools out.

## Requirements

- macOS with Docker Desktop running. Linux with Docker should work too but is untested.
- Node.js 24 or newer.
- The [treehouse](https://github.com/kunchenguid/treehouse) CLI on `PATH`, for `aos <agent>`'s worktrees.
  Not needed for `aos <agent> --here`. `aos doctor` and every worktree-leasing launch point at this URL and
  at `--here` if `treehouse` is missing.

## Install and first run

```sh
git clone https://github.com/codeVerine/agentic-os.git
cd agentic-os
npm install            # also compiles TypeScript to dist/
npm link               # puts `aos` on your PATH

aos init               # creates ~/AgenticOS/{secrets,projects}; secrets/ is mode 0700
aos image build        # builds aos-dev:local with your Mac UID/GID (a few minutes the first time)
aos doctor             # checks Docker, the image, and each agent's login and keys

aos secrets login codex      # once per agent you want to use (see below)
aos secrets login claude
aos secrets login opencode
aos secrets login pi

mkdir -p ~/code/demo && cd ~/code/demo
git init && git commit --allow-empty -m "Start demo"
aos pi                 # Pi's own interface, running in Docker, on this project
```

Set `AOS_ROOT` to use a directory other than `~/AgenticOS`.

Run the launchers from any directory inside a git repository, wherever it lives; `AOS_ROOT/projects/` is
only a convenient optional place for projects. The project is the git repository root of the directory you run
`aos` in. Only that folder is mounted into the container (or, without `--here`, only the worktree `aos` leased
for it). The agent starts in the same subdirectory you ran it from, or at the worktree root when that
subdirectory does not exist in the worktree, such as an untracked or ignored directory. The repository needs at least one commit (a Sandcastle requirement); a directory outside a git
repository is refused and `aos` never runs `git init` for you.

A linked worktree (`git worktree add`, including one `aos` itself leased from treehouse) works as the
launch directory too: Sandcastle also mounts the main repository's `.git` at its host path so git inside the
container can reach it. A worktree whose `.git` file uses a relative gitdir and a submodule are refused,
because git cannot resolve their repository from inside the container; run `aos` from the main checkout or
the superproject instead. Any other `.git` file, such as one made by `--separate-git-dir`, is refused too,
since the sandbox would have to mount a directory above the git directory.

For `aos <agent> --here`, the container path is `/home/agent/projects/<name>-<hash>`, where `<name>` is the
folder's basename and `<hash>` is the first 8 hex characters of the SHA-256 of its real host path. It is
stable for a folder, and `~/a/app` and `~/b/app` get different paths, so their Claude, Codex, OpenCode and Pi
history and trust entries never collide. Paths containing `:` or `,` are refused, since Docker bind mounts
cannot express them. A worktree `aos` leased itself gets a container path keyed the same way but off its own
branch name instead of its host path; see "Worktrees".

Arguments after the agent name go to the agent CLI unchanged:

```sh
aos claude --resume
aos codex --profile work
aos pi --model openrouter/moonshotai/kimi-k2.6
aos opencode --help
```

## Commands

| Command | What it does |
| --- | --- |
| `aos init` | Creates `AOS_ROOT` with an optional `projects/`, `secrets/` (0700), `secrets/env` (0600) and one login directory per agent. Safe to re-run; it resets the secrets permissions. |
| `aos doctor [--clean]` | Checks that Docker is reachable (including Docker Desktop's `~/.docker/run/docker.sock`), that `aos-dev:local` exists, matches your UID/GID and was built from this version of `docker/`, that `secrets/env` parses, that `treehouse` is on `PATH`, and which agents have a saved login or keys. It also reports stopped `aos-dev` containers left behind by sessions that could not clean up after themselves (for example after a `SIGKILL`, or a Docker restart, which shows as `Exited (255)`), and `aos doctor --clean` removes them. It only touches stopped containers named `sandcastle-*` that were started from `aos-dev:local`, never a running session. |
| `aos image build [docker build args]` | Builds `aos-dev:local` from `docker/Dockerfile` with `AGENT_UID`/`AGENT_GID` set to your Mac user, and labels it with a hash of `docker/`. Launches, logins and `aos doctor` refuse an image whose label does not match the installed aos, so rebuild after upgrading aos. |
| `aos secrets login <agent> [args]` | Runs the agent's own login flow in a throwaway `aos-dev` container that mounts only that agent's login directory. Extra arguments go to the agent's login command. |
| `aos claude` / `aos codex` / `aos opencode` / `aos pi` `[args]` | Leases a fresh worktree from the project's treehouse pool and opens the agent's interactive interface in it. See "Worktrees". |
| `aos claude --here` / etc. `[args]` | Opens the agent's interactive interface in the current directory, no worktree. |
| `aos worktree list` | Lists this project's aos-leased worktrees: id, agent, lease state, branch, clean/dirty, merged/unmerged. |
| `aos worktree merge <id>` | Merges that worktree's branch, locally, into the branch checked out in the project's main checkout, whichever of its worktrees you run the command from. |
| `aos worktree rm <id> [--force]` | Returns the lease and deletes the branch. Refuses while an `aos` process is still running an agent in it, or on uncommitted changes or a branch not yet merged into the main checkout's current branch, unless `--force`. Run from the main checkout or any of its worktrees, it checks against the main checkout. |
| `aos worktree prune` | Runs the same removal as `rm`, without `--force`, on every worktree that is already merged and clean, skipping any an `aos` process is still running an agent in. |

## Worktrees

`aos <agent>` (without `--here`) leases a worktree from the project's
[treehouse](https://github.com/kunchenguid/treehouse) pool, checks out a fresh branch under `aos/` on it
(`aos/<agent>/<timestamp>-<random>`), and runs the agent there instead of in the directory you ran `aos`
from. Several agents, or several runs of the same agent, can then work on one project at once, each on its
own branch and its own files, without waiting on each other or on git status in a shared checkout.

- **Base commit.** The new branch starts from the `HEAD` of wherever you ran `aos` from, not from whatever
  commit treehouse happened to leave the leased worktree on.
- **The lease stays held.** Unlike a plain `treehouse get`, `aos` never returns the lease when the agent's
  session ends: the worktree and its branch are kept until you explicitly run `aos worktree rm` (or
  `prune`), so treehouse's own prune and destroy leave it alone in the meantime. Landing the work: run
  `aos worktree merge <id>` to merge it into the branch checked out in your main checkout, then
  `aos worktree rm <id>` to release the lease and delete the now-merged branch. `aos worktree prune` does
  both steps for every worktree that already qualifies.
- **Resume and continue land you back in the right worktree, automatically.** Claude's `-r`/`--resume`/`-c`/
  `--continue`, Codex's `resume` subcommand, OpenCode's `-c`/`--session`, and Pi's `-c`/`-r`/`--session[-id]`
  all scope their own session lookup to the directory the agent is running in, so `aos` detects those flags
  and picks a worktree for you instead of leasing a new one, so there is no separate `aos` session flag to remember or
  pass. Long flags are recognised in both `--flag value` and `--flag=value` form:
  - **An explicit session id** (`claude --resume <id>`, `codex resume <id>`, `opencode --session <id>`,
    `pi --session <id>`/`--session-id <id>`) is looked up in that agent's own history under
    `~/AgenticOS/secrets/<agent>/` on the host (the same place a launch mounts into the container) and
    mapped back to whichever worktree it belongs to, however old. A session that ran in the project's own
    checkout instead (started with `--here`, or before worktree support) resumes there, exactly as `--here`
    would, without leasing anything. This works for Claude, Codex and Pi, whose
    history is either indexed by session id on disk (Claude, Codex) or laid out one directory per worktree
    the same way (Pi). **OpenCode keeps its sessions in a single SQLite database with no documented
    per-session-id index**, so `aos` cannot map an explicit `--session <id>` to a worktree reliably; it falls
    back to the most recently used OpenCode worktree instead and says so on stderr. If the id truly isn't the
    most recent one, `cd` into the right worktree (`aos worktree list` prints its path) and run
    `aos opencode --session <id> --here` from inside it.
  - **A bare flag with no id** (`-c`/`--continue`, or `--resume`/`-r` with nothing after it) lands you in the
    most recently used worktree for that agent in this project. A bare `--resume`/`-r` then opens that
    agent's own picker, which (same as the id lookup above) only lists sessions that ran in that one
    worktree, not every session you've ever had on this project.
  - If neither finds an existing worktree for this project and agent, `aos` says so on stderr and leases a
    new one, same as a plain launch.
- **Container path.** Each worktree's container path (`/home/agent/projects/<name>-<hash>`) is hashed from
  its own `aos/` branch name, not from the worktree's host path. treehouse reuses the same host directory for
  later, unrelated leases once one is returned, and since the container path is what keys Claude, Codex,
  OpenCode and Pi's own history, this keeps a later, unrelated session in a reused pool slot from ever
  landing in an earlier one's conversation.
- **`--here` is unaffected.** `aos <agent> --here` never leases a worktree, never creates a branch, and its
  resume/continue flags behave exactly as they did before worktree support: scoped to whatever directory you
  ran it from.
- **Config file.** treehouse's own `treehouse.toml` (`treehouse init` to create one) controls where the pool
  lives and how large it grows; `aos` does not manage that file. Without one, treehouse uses its own
  defaults.
- **Out of scope.** `aos` does not open a PR, push anywhere, or touch the repository's remote; "merge" is a
  local `git merge`, same as you'd run by hand, and every host git call `aos worktree merge/rm/prune` makes
  runs with the same hook and fsmonitor protection described in "Warning: host git in agent-written
  projects" below. Worktrees narrow the blast radius of a bad edit to their own branch, but a leased
  worktree's `.git` is still the project's real, shared one, and `aos` adds no other git-tampering
  protection beyond that.

## Subscriptions and API keys

### Agent logins

Each agent keeps its container login under `~/AgenticOS/secrets/<agent>/`, mounted at the place the agent
expects it:

| Agent | `aos secrets login` runs | Stored in | Mounted at |
| --- | --- | --- | --- |
| Claude Code | `claude auth login`: open the printed URL on the Mac, sign in with your Claude subscription, paste the code back | `secrets/claude/` | `~/.claude` (`CLAUDE_CONFIG_DIR`) |
| Codex | `codex login --device-auth`: open the printed URL on the Mac and enter the one-time code for your ChatGPT (Codex) subscription | `secrets/codex/` | `~/.codex` (`CODEX_HOME`) |
| OpenCode | `opencode auth login`: pick OpenCode Zen or OpenCode Go for the OpenCode subscription and paste its key | `secrets/opencode/{data,config,state}/` | `~/.local/share/opencode`, `~/.config/opencode`, `~/.local/state/opencode` |
| Pi | Pi's own interface: type `/login`, pick the provider, follow its prompts, then quit | `secrets/pi/` | `~/.pi/agent` (`PI_CODING_AGENT_DIR`) |

Notes:

- Codex's "Sign in with ChatGPT" browser option does not work in a container, because its callback server
  listens inside the container. Use the default device-code flow. `aos secrets login codex --with-api-key`
  reads an API key from stdin instead.
- You can also log in from the agent's own interface during a normal launch (`/login` in Claude Code or Pi,
  `/connect` in OpenCode). The result lands in the same directory and every project uses it.
- Login directories also hold each agent's settings, transcripts and history, so resuming a session works
  per project as it does on the Mac.

One login serves every project, including several sessions running at once. All containers run in the same
Docker Desktop Linux VM and see the same files, and file locks taken in one container block the others, so
an agent's own lock files work across containers as they do between processes on one machine:

- Claude Code and Pi lock their credential files while refreshing tokens.
- Codex (0.158) re-reads `auth.json` before refreshing its ChatGPT tokens, but its refresh lock only covers
  one process, and every refresh replaces the refresh token. Two containers refreshing at the same moment
  would send the same refresh token, and the second would be rejected as already used. `aos codex` therefore
  starts a small local server in each container (`docker/codex-refresh.mjs`) and points Codex's refresh
  requests at it. It runs each refresh under a lock directory in `secrets/codex/` and gives a refresh that
  still carries the replaced token the same new tokens, so only one refresh reaches OpenAI.
- OpenCode (1.18.33) keeps logins in `auth.json`. The OpenCode subscription (Zen or Go) and API keys never
  refresh, and neither does a GitHub Copilot login. OpenCode's built-in ChatGPT login does refresh with the
  same rotating tokens as Codex, under an in-process guard only, and OpenCode offers no way to redirect it.
  Use `aos codex` for the ChatGPT subscription when several sessions may run at once.

Codex's background server keeps pid and socket files that only make sense inside one container, so `aos`
also gives each Codex launch a fresh directory for them.

### API keys: `~/AgenticOS/secrets/env`

`secrets/env` holds API keys as `KEY=VALUE` lines and must stay mode 0600. Each launch passes a container
only the keys its agent uses:

- `claude`: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`
- `codex`: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, `OPENROUTER_API_KEY`
- `opencode` and `pi`: the Anthropic and OpenAI keys above, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`,
  `AI_GATEWAY_API_KEY`, and the common provider keys (`GEMINI_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`,
  `MISTRAL_API_KEY`, `XAI_API_KEY`, and others listed in `src/agents.ts`). Pi also gets
  `ANTHROPIC_OAUTH_TOKEN`.

For a key with any other name, such as another router provider's key, put it under an `[agent]` section.
Keys in a section go to that agent only:

```ini
OPENROUTER_API_KEY=sk-or-...

[pi]
MY_ROUTER_API_KEY=...

[opencode]
MY_ROUTER_API_KEY=...
```

`aos doctor` warns about top-level keys that no agent would receive.

A key reaches the agent as an environment variable. Agents with built-in support for the provider pick it up
directly: OpenRouter appears in Pi's and OpenCode's model pickers as soon as `OPENROUTER_API_KEY` is set.
For a provider an agent does not know, add it to that agent's own configuration inside its login directory,
where it persists for every project:

- Pi: `secrets/pi/models.json`, for example
  `{"providers": {"myrouter": {"baseUrl": "https://router.example/v1", "api": "openai-completions", "apiKey": "$MY_ROUTER_API_KEY", "models": [{"id": "model-id"}]}}}`
- OpenCode: `secrets/opencode/config/opencode.json`, for example
  `{"provider": {"myrouter": {"npm": "@ai-sdk/openai-compatible", "options": {"baseURL": "https://router.example/v1", "apiKey": "{env:MY_ROUTER_API_KEY}"}, "models": {"model-id": {}}}}}`
- Codex: a `model_providers` entry with `env_key` in `secrets/codex/config.toml`.

## Permissions in the container: everything allowed by default

The container is the sandbox, so every agent starts in full-autonomy mode: no permission prompts, no approval
requests, no inner sandbox, and no "do you trust this folder?" question for a new project. You change any of
it from the agent's own settings, its own command line, or its own interface.

| Agent | Default | Where it is set | Turn prompts back on |
| --- | --- | --- | --- |
| Claude Code | bypass-permissions mode | `permissions.defaultMode` and `skipDangerousModePermissionPrompt` in `secrets/claude/settings.json` | Set `"permissions": {"defaultMode": "default"}` (or `"acceptEdits"`, `"plan"`) in that file. One launch: `aos claude --permission-mode default`. In a session: Shift+Tab cycles the mode and `/permissions` edits the rules. |
| Codex | `approval_policy = "never"`, `sandbox_mode = "danger-full-access"` (its header shows "permissions: YOLO mode") | `/etc/codex/config.toml` in the image, Codex's lowest config layer | Put `approval_policy = "on-request"` and `sandbox_mode = "workspace-write"` at the top of `secrets/codex/config.toml`. One launch: `aos codex -a on-request -s workspace-write`. In a session: `/permissions`. |
| OpenCode | `"permission": {"*": "allow"}` | `secrets/opencode/config/config.json`, the lowest file of OpenCode's global config | Put your own `permission` in `secrets/opencode/config/opencode.json` (or `opencode.jsonc`), which overrides `config.json`, for example `{"permission": {"bash": "ask", "edit": "ask"}}`. A project's own `opencode.json` overrides both. |
| Pi | Pi never asks before running a tool; `defaultProjectTrust: "always"` also loads a project's `.pi/` settings, extensions and skills without asking | `secrets/pi/settings.json` | Set `"defaultProjectTrust": "ask"`. In a session: `/trust`. |

How the defaults are applied:

- Codex's default lives in the image, so nothing in `secrets/codex/` is written for it. `aos codex` only adds
  the `[projects."/home/agent/projects/<name>-<hash>"] trust_level = "trusted"` entry that Codex itself writes when
  you accept its trust prompt, and leaves a `config.toml` that already mentions the project alone.
- Claude Code, OpenCode and Pi have no config layer below the user's own file, so `aos` fills the keys above
  into that file at launch **only when they are absent**. Whatever you set stays, including a value that
  turns the default off. Removing a key brings the default back. A file that is not valid JSON stops the
  launch with an error instead of being rewritten.
- Claude Code's trust prompt has no setting, so `aos claude` sets `CLAUDE_CODE_SANDBOXED=1`, which Claude
  Code treats as "this workspace is already sandboxed".
- Changes to these files apply from the next launch. A project's own `.claude/settings.json` or
  `opencode.json` still overrides the user-level defaults, as it does on the Mac.
- Codex's own sandbox (bubblewrap) cannot create namespaces inside Docker. Turning `sandbox_mode` back on
  makes its sandboxed commands fail, and the model then has to ask you to approve running them outside it.

Full autonomy does not make the container harmless: an agent can still use the network, its own login and the
API keys passed to it, and write anything in the project. See "Deliberately skipped for now".

## Warning: host git in agent-written projects

Agents can write anything into a project, including `.git/config`, `.git/hooks/*` and files that git runs
filters or an fsmonitor on. Every host git call `aos` itself makes, for Sandcastle and for its own worktree
commands (`aos worktree merge/rm/prune`, and branch setup on a fresh worktree), runs with
`core.hooksPath=/dev/null` and `core.fsmonitor=false`, but your own git commands, editor integrations and
tools such as `gh` or `pre-commit` do not.

Do not run hook-sensitive git commands (`commit`, `checkout`, `merge`, `pull`, `rebase`, `push`) on the Mac
inside a project an agent has worked in. Review the changes from inside an agent session instead (for
example `!git diff` in Pi or Codex). If you must use git on the Mac there, inspect `.git/config` and
`.git/hooks` first.

## Deliberately skipped for now

This is the MVP's first slice. It skips, on purpose:

- Headless sessions driven from chat (`start`, `send`, `stop`, `status`, `logs`), a runner, and a queue.
- Per-repository GitHub tokens through a GitHub App, and repository creation. Containers get no GitHub
  credentials; `gh` in the image is unauthenticated.
- Host metrics, ZeroClaw, Telegram and notifications.
- Deeper isolation and hardening: dropped capabilities, read-only root filesystem, resource limits, egress
  filtering, per-session networks and fresh per-session clones. Containers use Docker's default bridge
  network, which on Docker Desktop can reach services on the Mac's localhost.
- Keeping secrets out of process arguments: Sandcastle passes a launch's selected keys to `docker run -e`,
  so they are visible to local users in the process list and in `docker inspect` while the container runs.
- Multi-arch image publishing and CI; the image is built locally.

## Development

```sh
npm run build       # tsc to dist/
npm run typecheck   # src and tests
npm test            # node:test unit tests
```

`AOS_ROOT` points every command at another root, which keeps experiments away from `~/AgenticOS`.
