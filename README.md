# agentic-os

Personal agentic OS for software development.

This repository holds `aos`, a small Node/TypeScript CLI. `aos` opens a coding agent's own interactive
interface (Claude Code, Codex, OpenCode or Pi) for the project you are in, with the agent running in a
Docker container through [Sandcastle](https://github.com/mattpocock/sandcastle) instead of directly on the
Mac. You `cd` into a project and run `aos pi` the same way you would run `pi`: the same interface, the same
model picker, the same keys.

## What runs where

- Agents run only inside the local `aos-dev:local` image (Debian bookworm, Node 24, git, gh, ripgrep, fd,
  Python, build tools, and pinned `claude`, `codex`, `opencode` and `pi` CLIs). They never run on the Mac.
- Every launch goes through Sandcastle's `interactive()` API with its Docker provider, in `head` mode: the
  project directory is bind-mounted read-write, so the agent's edits and commits land in the project on the
  Mac directly.
- The container sees the project, the project's `.git`, and that agent's own login directory from
  `~/AgenticOS/secrets/<agent>/`. It never sees the Mac's `~/.ssh`, `gh` login, `~/.claude`, `~/.codex`,
  OpenCode or Pi homes, and `aos` never reads them.
- Each agent logs in once, inside a container. That login is stored under `~/AgenticOS/secrets/<agent>/` and
  shared by every project, so the Mac's own agent logins are never touched, and a token refreshed in a
  container never logs the Mac's own tools out.

## Requirements

- macOS with Docker Desktop running. Linux with Docker should work too but is untested.
- Node.js 24 or newer.

## Install and first run

```sh
git clone https://github.com/codeVerine/agentic-os.git
cd agentic-os
npm install            # also compiles TypeScript to dist/
npm link               # puts `aos` on your PATH

aos init               # creates ~/AgenticOS/{projects,secrets}; secrets/ is mode 0700
aos image build        # builds aos-dev:local with your Mac UID/GID (a few minutes the first time)
aos doctor             # checks Docker, the image, and each agent's login and keys

aos secrets login codex      # once per agent you want to use (see below)
aos secrets login claude
aos secrets login opencode
aos secrets login pi

mkdir -p ~/AgenticOS/projects/demo && cd ~/AgenticOS/projects/demo
git init && git commit --allow-empty -m "Start demo"
aos pi                 # Pi's own interface, running in Docker, on this project
```

Set `AOS_ROOT` to use a directory other than `~/AgenticOS`.

Run the launchers from anywhere inside `AOS_ROOT/projects/<project>`. The agent starts in the same
subdirectory, at `/home/agent/projects/<project>/...` in the container. `aos` refuses to start anywhere else.
Sandcastle needs each project to be a git repository with at least one commit.

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
| `aos init` | Creates `AOS_ROOT` with `projects/`, `secrets/` (0700), `secrets/env` (0600) and one login directory per agent. Safe to re-run; it resets the secrets permissions. |
| `aos doctor` | Checks that Docker is reachable (including Docker Desktop's `~/.docker/run/docker.sock`), that `aos-dev:local` exists, matches your UID/GID and was built from this version of `docker/`, that `secrets/env` parses, and which agents have a saved login or keys. |
| `aos image build [docker build args]` | Builds `aos-dev:local` from `docker/Dockerfile` with `AGENT_UID`/`AGENT_GID` set to your Mac user, and labels it with a hash of `docker/`. Launches, logins and `aos doctor` refuse an image whose label does not match the installed aos, so rebuild after upgrading aos. |
| `aos secrets login <agent> [args]` | Runs the agent's own login flow in a throwaway `aos-dev` container that mounts only that agent's login directory. Extra arguments go to the agent's login command. |
| `aos claude` / `aos codex` / `aos opencode` / `aos pi` `[args]` | Opens the agent's interactive interface for the current project. |

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

## Codex permissions in the container

Codex normally wraps each command in its own bubblewrap sandbox. Bubblewrap cannot create namespaces inside
a Docker container, so every command would fail. The image therefore sets `sandbox_mode =
"danger-full-access"` in `/etc/codex/config.toml`: the container is the sandbox, and Codex still asks for
approval as usual. Your own `secrets/codex/config.toml`, `-s`/`--sandbox` and `/permissions` override it.

## Warning: host git in agent-written projects

Agents can write anything into a project, including `.git/config`, `.git/hooks/*` and files that git runs
filters or an fsmonitor on. `aos` itself runs git on the Mac for Sandcastle with
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
npm test            # node:test unit tests (paths, secrets, per-agent environment)
```

`AOS_ROOT` points every command at another root, which keeps experiments away from `~/AgenticOS`.
