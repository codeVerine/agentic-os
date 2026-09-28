# Phase A verification: interactive agents through Sandcastle

Recorded on 2026-09-28 on the captain's Mac: macOS 27.0 on arm64, Docker Desktop 29.8.0 (context
`desktop-linux`), Node 24.16.0, `@ai-hero/sandcastle` 0.12.0.

All runs used `AOS_ROOT=<worktree>/.lab/AgenticOS`, so nothing was written to `~/AgenticOS`. Terminal
sessions ran inside tmux 3.7c, which provided a real TTY and a way to resize it, paste into it and capture
the screen. Screens below are `tmux capture-pane` text. Long output is trimmed.

## Credentials: what was and was not proven

No real subscription or API credentials were available to the implementing agent. `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY` and the router key were set but empty. So:

- **Claude Code**: the TUI and the in-container login flow were reached. The login itself is **pending**:
  it needs the captain to sign in with the Claude subscription.
- **Codex, OpenCode and Pi** were logged in once with **dummy** keys through their own login flows:
  `codex login --with-api-key`, OpenCode's "OpenCode Zen" API-key prompt, and Pi's `/login` with an
  OpenRouter key. This proves that one login in `secrets/<agent>/` serves every project with no second login
  prompt, including concurrent sessions. It does not prove that a real model call works, and live token
  refresh races were not exercised, because no OAuth tokens were available. See "Token refresh with a
  shared login" for what the agents' source shows and what aos adds for Codex.
- The real subscription logins (Codex device code, Claude subscription, OpenCode subscription) reach their
  prompts in the container (see "Login flows") and are **pending** the captain.

## Image build

```text
$ aos image build
#5 [1/8] FROM docker.io/library/node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
#10 [2/8] RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap build-essential ca-certificates curl fd-find git jq less locales openssh-client procps python3 ripgrep ...
#8 [3/8] RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg ... && apt-get install -y --no-install-recommends gh ...
#7 [4/8] RUN npm install -g @anthropic-ai/claude-code@2.1.283 @openai/codex@0.158.0 opencode-ai@1.18.33 @earendil-works/pi-coding-agent@0.87.1 && npm cache clean --force
#11 [5/8] RUN mkdir -p /etc/codex && printf 'sandbox_mode = "danger-full-access"\n' > /etc/codex/config.toml
#6 [6/8] RUN groupmod -o -g "20" node && usermod -o -u "501" -g "20" -d /home/agent -m -l agent node
#9 [7/8] RUN install -d -o "501" -g "20" /home/agent/.cache /home/agent/.claude /home/agent/.codex ...
#12 [8/8] WORKDIR /home/agent
#13 naming to docker.io/library/aos-dev:local done

$ docker run --rm --entrypoint sh aos-dev:local -c "..."
2.1.283 (Claude Code)
codex-cli 0.158.0
opencode 1.18.33
pi 0.87.1
gh version 2.101.0 (2026-09-15)
git version 2.39.5
v24.21.0
uid=501(agent) gid=20(dialout) groups=20(dialout)
```

The image user is `501:20`, the Mac user's UID and GID, which Sandcastle's pre-flight check requires.

This build predates the `COPY codex-refresh.mjs` step and the `aos.context-hash` label that `aos image build`
now adds, and its `/etc/codex/config.toml` step is the one the full-autonomy change replaced (see "Full-autonomy
defaults" below); none of these has been re-recorded here.

## `aos init` and `aos doctor`

Fresh root:

```text
$ AOS_ROOT=/tmp/aos-fresh aos init
aos root      /tmp/aos-fresh
projects      /tmp/aos-fresh/projects
secrets       /tmp/aos-fresh/secrets (0700)
secrets env   /tmp/aos-fresh/secrets/env (0600, created from template)
agent logins  /tmp/aos-fresh/secrets/claude, /tmp/aos-fresh/secrets/codex, /tmp/aos-fresh/secrets/opencode, /tmp/aos-fresh/secrets/pi
$ AOS_ROOT=/tmp/aos-fresh aos doctor
✓ root       /tmp/aos-fresh
✓ secrets    /tmp/aos-fresh/secrets (mode 700)
✓ env file   /tmp/aos-fresh/secrets/env (0 shared keys)
✓ docker     server 29.8.0 via context desktop-linux (unix:///Users/sagar/.docker/run/docker.sock)
✓ image      aos-dev:local (user 501:20)
! claude     no login; no keys: run "aos secrets login claude" or add a key to /tmp/aos-fresh/secrets/env
! codex      no login; no keys: run "aos secrets login codex" or add a key to /tmp/aos-fresh/secrets/env
! opencode   no login; no keys: run "aos secrets login opencode" or add a key to /tmp/aos-fresh/secrets/env
! pi         no login; no keys: run "aos secrets login pi" or add a key to /tmp/aos-fresh/secrets/env
```

Lab root after the dummy logins, with `OPENROUTER_API_KEY` at top level and `TOKENROUTER_API_KEY` under
`[pi]` in `secrets/env`:

```text
$ aos doctor
✓ root       <worktree>/.lab/AgenticOS
✓ secrets    <worktree>/.lab/AgenticOS/secrets (mode 700)
✓ env file   <worktree>/.lab/AgenticOS/secrets/env (1 shared key, sections [pi])
✓ docker     server 29.8.0 via context desktop-linux (unix:///Users/sagar/.docker/run/docker.sock)
✓ image      aos-dev:local (user 501:20)
! claude     no login; no keys: run "aos secrets login claude" or add a key to <worktree>/.lab/AgenticOS/secrets/env
✓ codex      login saved; keys OPENROUTER_API_KEY
✓ opencode   login saved; keys OPENROUTER_API_KEY
✓ pi         login saved; keys OPENROUTER_API_KEY, TOKENROUTER_API_KEY
```

With the docker CLI's context hidden (`DOCKER_CONFIG=/nonexistent`), `aos` falls back to Docker Desktop's
socket:

```text
✓ docker     server 29.8.0 via DOCKER_HOST=unix:///Users/sagar/.docker/run/docker.sock
```

## One real interactive launch per agent

All six sessions below ran at the same time, from two projects (`demo-a`, with Pi started from
`demo-a/sub`, and `demo-b`). `docker ps` showed six `sandcastle-*` containers.

Claude Code (`aos claude` in `demo-a`) reaches its first-run onboarding. Pressing Enter moves on to its login
method picker, which is where the pending subscription login would happen:

```text
 Let's get started.
 Choose the text style that looks best with your terminal
 To change this later, run /theme
   1. Auto (match terminal)
 ❯ 2. Dark mode ✔
   3. Light mode
   ...
 Select login method:
 ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise
   2. Anthropic Console account · API usage billing
   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI
```

Codex (`aos codex` in `demo-a` and `demo-b` at once), both past login with no prompt, each in its own
project:

```text
  >_ OpenAI Codex (v0.158.0)
     ~/projects/demo-a
› Ask Codex to do anything
  GPT-6-Astra default · ~/projects/demo-a

  >_ OpenAI Codex (v0.158.0)
     ~/projects/demo-b
› Ask Codex to do anything
  GPT-6-Astra default · ~/projects/demo-b

/status in demo-b:
│  Directory:            ~/projects/demo-b                                   │
│  Permissions:          Custom (danger-full-access, Ask for approval)       │   (before the full-autonomy change)
│  Account:              API key configured (run codex login to use ChatGPT) │
```

OpenCode (`aos opencode` in `demo-a`), with OpenRouter models available from `OPENROUTER_API_KEY`:

```text
                       ┃  Ask anything… "Fix a TODO in the codebase"
                       ┃  Build · Nano Banana Pro Preview OpenRouter
                                                                       tab agents  ctrl+p commands
  ~/projects/demo-a                                                                                            1.18.33
```

Pi (`aos pi` in `demo-a/sub` and in `demo-b` at once), both logged in through the shared `auth.json`, with
the agent starting in the subdirectory it was launched from:

```text
 pi v0.87.1
~/projects/demo-a/sub (main)
0.0%/262k (auto)                                                                           moonshotai/kimi-k2.6 • medium

 pi v0.87.1
~/projects/demo-b (main)
0.0%/262k (auto)                                                                           moonshotai/kimi-k2.6 • medium
```

Every session exited with the agent's own quit key (`/quit`, Ctrl+D or Ctrl+C), printed Sandcastle's
"Session Complete" summary, and returned `AOS_EXIT=0`. Afterwards `docker ps --filter name=sandcastle` was
empty and `state/run/` held no leftover directories.

## Full TTY behaviour

- **Model pickers**: Codex `/model` listed its models, Pi `/model` listed 397 OpenRouter models from the
  shared login, OpenCode `/models` opened its model dialog, and Claude Code's onboarding and login pickers
  responded to arrow keys and Enter.
- **Colors**: Pi's screen carried 24-bit color escapes (`ESC[38;2;102;102;102m` and others). Containers get
  `TERM=xterm-256color`, which the image has terminfo for, and the host's `COLORTERM`, `TERM_PROGRAM` and
  `TERM_PROGRAM_VERSION`.
- **Resize**: resizing the tmux window from 160 to 90 columns, and in the final run from 120 to 80, redrew
  Pi's separators and status line at the new width:

  ```text
  ────────────────────────────────────────────────────────────────────────────────
  ~/projects/demo-a/sub (main)
  0.0%/262k (auto)                                   moonshotai/kimi-k2.6 • medium
  ```

- **Paste**: a bracketed paste of two lines with non-ASCII text arrived intact in Pi's editor:

  ```text
  pasted line one
  pasted line two ünïcödé ✓
  ```

- **Arguments**: `aos codex --version` printed `codex-cli 0.158.0` from the container, and `aos opencode auth
  list` in `demo-b` listed the shared `OpenCode Zen` credential.
- **Shell commands** from the agent UI run in the container on the per-project mount (Codex `!` command):

  ```text
  • You ran git status --short --branch && pwd && ls
    └ ## main
      /home/agent/projects/demo-a
      README.md
      sub
  ```

## Login flows (`aos secrets login <agent>`)

- `claude`: printed `If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&...`
  and `Paste code here if prompted >`. Pending the captain.
- `codex`: printed the device-code steps (`https://auth.openai.com/codex/device` and a one-time code).
  Pending the captain. `aos secrets login codex --with-api-key` stored the dummy key:
  `Successfully logged in`, `aos: codex login saved in .../secrets/codex`.
- `opencode`: showed its provider picker (`OpenCode Zen (recommended)`, OpenAI, GitHub Copilot, Google,
  Anthropic, OpenRouter, ...), then `Enter your API key`, then `Done` and
  `aos: opencode login saved in .../secrets/opencode`.
- `pi`: opened Pi's interface. `/login`, then "Sign in with an API key", then OpenRouter printed
  `Saved API key for OpenRouter. ... Credentials saved to /home/agent/.pi/agent/auth.json`, and
  `aos: pi login saved in .../secrets/pi` on exit.

## Shared login across concurrent containers

- All containers mount the same `secrets/<agent>/` directory from the Mac, and all run in the one Docker
  Desktop Linux VM. File locks taken in one container block the other on that bind mount:

  ```text
  flock: blocked by other container (ok)
  fcntl: blocked by other container (ok)
  mkdir lock 1: acquired
  mkdir lock 2: blocked (ok)
  ```

  So the agents' own locking behaves as it does between processes on one Mac. Claude Code's binary takes a
  `refresh.lock` and re-reads `.credentials.json` when its mtime changes. Pi locks `auth.json` with
  `proper-lockfile`. Claude Code's session registry records the pid namespace (`"pidDomain":"linux::pid:[...]"`),
  so identical pids in two containers do not collide.
- Codex 0.158 starts a shared background server per `CODEX_HOME`. Its socket is a symlink into the
  container's own `/tmp`, but its pid files lived in the shared directory. With two concurrent containers,
  the second overwrote `daemon.pid` with a pid from its own namespace. `aos` now mounts a fresh per-launch
  directory over `~/.codex/app-server-daemon` and `~/.codex/app-server-control`. After the change, two
  concurrent Codex sessions each had their own daemon state under `state/run/codex-*`, and `aos` removed
  both directories on exit.

## Token refresh with a shared login: what the agents' source shows

Read from the pinned sources: `openai/codex` tag `rust-v0.158.0` (`codex-rs/login/src/auth/manager.rs`,
`storage.rs`) and `anomalyco/opencode` tag `v1.18.33` (`packages/opencode/src/auth/index.ts`,
`src/plugin/openai/codex.ts`, `src/plugin/index.ts`).

- **Codex**, ChatGPT login: `AuthManager::refresh_token` takes `refresh_lock`, a `tokio` semaphore that only
  covers one process. Inside it, it reloads `auth.json` and skips the refresh when the file changed
  ("guarded reload"). Otherwise it posts the refresh token to `https://auth.openai.com/oauth/token`, or to
  `CODEX_REFRESH_TOKEN_URL_OVERRIDE` when set, and saves the returned tokens. `FileAuthStorage::save`
  truncates and rewrites `auth.json` with no file lock. The refresh token rotates: Codex handles the
  `refresh_token_reused` error ("your refresh token was already used"). Refreshes one after another are
  safe, because the second process re-reads the file first. Two containers whose refreshes overlap both
  send the old token, and the second is rejected.
- **aos fix**: `aos codex` sets `CODEX_REFRESH_TOKEN_URL_OVERRIDE` to `http://127.0.0.1:48123/oauth/token`
  and starts `docker/codex-refresh.mjs` in the container before Codex. The server runs each refresh under the
  `secrets/codex/.aos-refresh.lock` directory (mkdir locks block across containers, see above), forwards it
  to OpenAI, and records the successful response in `secrets/codex/.aos-refresh.json` (mode 0600). A refresh
  that carries the token the last rotation replaced gets that recorded response instead of a second upstream
  call. `test/codex-refresh.test.ts` runs two such servers on one `CODEX_HOME` against a fake authority that
  rejects reused tokens: two concurrent refreshes reach the authority once and both get the new tokens.
- **OpenCode**: `Auth.set` reads and rewrites the whole `auth.json` with no file lock. The OpenCode
  subscription (Zen, Go) and other API keys are stored as `api` entries and never refresh. The GitHub Copilot
  login stores a GitHub token that does not rotate. The built-in ChatGPT login refreshes against
  `https://auth.openai.com/oauth/token` with a rotating refresh token, guarded only by an in-process promise.
  Its issuer can only be changed through plugin options that OpenCode fills in internally, so aos has no way
  to serialize it. The README tells the captain to use `aos codex` for the ChatGPT subscription.

Still needs a real subscription login: that OpenAI rejects a reused refresh token as the source expects, that
Codex accepts the lock server's responses end to end, and whether OpenAI revokes the whole token family after
a reuse (which would make the OpenCode ChatGPT case log out every session).

## Environment and mounts

- Per-agent keys: Pi's container had `OPENROUTER_API_KEY` and the `[pi]`-only `TOKENROUTER_API_KEY`. Claude
  Code's container environment held only
  `CLAUDE_CONFIG_DIR COLORTERM HOME LANG LC_ALL NODE_VERSION PATH TERM TERM_PROGRAM TERM_PROGRAM_VERSION YARN_VERSION`.
- Host environment scrubbing: `demo-b/.sandcastle/.env` listed `AOS_LAB_HOST_SECRET=` and `SSH_AUTH_SOCK=`,
  and `aos claude` was started with `AOS_LAB_HOST_SECRET=should-not-leak`. Neither variable reached the
  container.
- Mounts of a Pi container: the project at `/home/agent/workspace` (Sandcastle) and at
  `/home/agent/projects/demo-a` (aos), the project's `.git`, and `secrets/pi` at `/home/agent/.pi/agent`.
  Nothing from `~/.ssh`, `~/.config/gh`, `~/.claude`, `~/.codex`, `~/.pi` or OpenCode's Mac directories.
- The Mac's own agent homes gained no transcripts with container paths: `~/.codex/sessions`, `~/.pi` and
  `~/.local/share/opencode` had no files mentioning `/home/agent/projects`, and `~/.claude/projects` had no
  `-home-agent-*` directory.

## Full-autonomy defaults

Recorded on 2026-09-28 with the same lab setup as above, on a rebuilt `aos-dev:local` (the image's
`/etc/codex/config.toml` now holds `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`, and the
container user is still `uid=501(agent) gid=20(dialout)`, not root). Projects `demo-e` to `demo-h` were new, so
none had a saved trust decision.

How the tool-call checks below were made: no real model credentials were available, so each agent was pointed
at a small local fake model server on the Mac (`host.docker.internal`, Docker Desktop's name for the Mac). The
fake answers the agent's first prompt, `run marker`, with one shell tool call, `echo aos-ran > marker.txt`. The
agent's own permission system then decides between running it and asking. The fake servers are throwaway
scripts, not part of the repository. Screens are the terminal's final state, trimmed.

### Every agent starts without a prompt

Claude Code (`aos claude` in a new project, from `demo-h/x`), whose `secrets/claude/settings.json` held only
`{"theme": "dark"}` beforehand. aos added the two keys, the trust dialog and the "Bypass Permissions mode"
warning did not appear, and the tool call ran:

```text
$ cat secrets/claude/settings.json
{ "theme": "dark", "permissions": { "defaultMode": "bypassPermissions" }, "skipDangerousModePermissionPrompt": true }
 ▐▛███▛█   Claude Code v2.1.283
 ▝▝   ▝▝   ~/projects/demo-h/x
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
❯ run marker
● Bash(echo aos-ran > marker.txt)
  ⎿  Created marker.txt (+1 -0)
● Marker step finished.
```

The brief expected Claude Code to refuse the bypass mode as root unless `IS_SANDBOX=1`. That never came up: the
container user is uid 501, not root, and both `--dangerously-skip-permissions` and `permissions.defaultMode`
worked as that user without `IS_SANDBOX`.
Without `CLAUDE_CODE_SANDBOXED=1` the same launch stopped at "Accessing workspace: ... Yes, I trust this
folder", and without `skipDangerousModePermissionPrompt` at "WARNING: Claude Code running in Bypass
Permissions mode ... Yes, I accept".

Codex (`aos codex` from `demo-g/deep/er`, a subdirectory of a new project). Before aos wrote the trust entry,
even `-a never -s danger-full-access` stopped at "Trust this folder?", and a `-c projects...` override did not
skip it from a subdirectory. Now `secrets/codex/config.toml` gains
`[projects."/home/agent/projects/demo-g"] trust_level = "trusted"` and Codex opens directly. From `demo-h`, the
tool call ran with no approval:

```text
  >_ OpenAI Codex (v0.158.0)
     ~/projects/demo-h
  permissions: YOLO mode
› run marker
• Ran echo aos-ran > marker.txt
  └ (no output)
• Marker step finished.
```

OpenCode (`aos opencode -m openai/gpt-5`), with `secrets/opencode/config/config.json` created by aos as
`{"$schema": "https://opencode.ai/config.json", "permission": {"*": "allow"}}` (OpenCode added the schema line).
The command below reads outside the project (`/etc/hostname`) and writes outside it
(`/home/agent/outside.txt`), which stock OpenCode asks about, and ran unasked:

```text
  ┃  run marker
  ┃  $ cat /etc/hostname > /home/agent/outside.txt; cat /etc/hostname
  ┃  cba5794da84e
     Marker step finished.
     ▣  Build · GPT-5 · 1.1s
```

Pi (`aos pi --model fake/fake-model`, a custom provider in `secrets/pi/models.json`) ran its bash tool with
no prompt, which matches its documentation ("it does not ask for approval before every tool call"). Its one
prompt is project trust. `demo-e` holds a `.pi/settings.json`, and before the change `aos pi` there stopped at:

```text
 Trust project folder?
 /home/agent/projects/demo-e
 → Trust
   Trust parent folder (/home/agent/projects)
   Trust (this session only)
   Do not trust
   Do not trust (this session only)
```

`aos` now adds `"defaultProjectTrust": "always"` to `secrets/pi/settings.json`, and the same project opens on
Pi's normal screen (`pi v0.87.1`, `~/projects/demo-e (main)`).

### Overrides turn the prompts back on

Each override below was made with the agent's own setting or flag, with the same `run marker` call. In every
case the command waited for an answer instead of running.

- Claude Code, `"permissions": {"defaultMode": "default"}` in `secrets/claude/settings.json` (aos left the
  value alone on the next launch), and separately `aos claude --permission-mode default` with the bypass
  default in the file:

  ```text
   Bash command
     echo aos-ran > marker.txt
   Do you want to proceed?
   ❯ 1. Yes
     2. Yes, and always allow access to /home/agent/projects/demo-h from this project
     3. Yes, and switch to auto mode · auto mode handles these prompts for you
     4. No
  ```

- Codex, `approval_policy = "on-request"` and `sandbox_mode = "workspace-write"` at the top of
  `secrets/codex/config.toml`, and separately `aos codex -a on-request -s workspace-write`. Its sandbox cannot
  work in Docker, so a command Codex runs inside it fails
  (`bwrap: No permissions to create new namespace`); a command the model asks to run outside it prompts:

  ```text
  • Running echo aos-ran > marker.txt
    Would you like to run the following command?
    Reason: write the marker
  › 1. Yes, proceed (y)
    2. Yes, and don't ask again for commands that start with `echo aos-ran > marker.txt` (p)
    3. No, and tell Codex what to do differently (esc)
  ```

  Codex 0.158 no longer accepts `approval_policy = "untrusted"` ("is no longer supported"); `on-request` and
  `never` are its only values.

- OpenCode, `{"permission": {"bash": "ask"}}` in `secrets/opencode/config/opencode.json`, which overrides the
  aos-owned `config.json` (`opencode debug agent build` lists both rules, with `bash: ask` last):

  ```text
  ┃  △ Permission required
  ┃    # Shell command
  ┃  $ cat /etc/hostname > /home/agent/outside.txt; cat /etc/hostname
  ┃   Allow once   Allow always   Reject
  ```

Not exercised: Pi's `defaultProjectTrust: "ask"` override was not run, and no real model was involved for any
agent, so a real model's own refusals or extra approval requests are not covered.

## Refusals

```text
$ aos pi                              # from the repository, outside AOS_ROOT
aos: <worktree> is not inside a project. cd into <worktree>/.lab/AgenticOS/projects/<project> and run the command again.
$ aos codex                           # from AOS_ROOT/projects itself
aos: <worktree>/.lab/AgenticOS/projects is not inside a project. cd into <worktree>/.lab/AgenticOS/projects/<project> and run the command again.
$ aos claude                          # project that is not a git repository
aos: Project nogit is not a git repository. Sandcastle needs one: run "git init" in <worktree>/.lab/AgenticOS/projects/nogit and make a first commit.
$ aos opencode                        # git repository without commits
aos: Project empty has no commits yet. Sandcastle needs one: make a first commit in <worktree>/.lab/AgenticOS/projects/empty.
$ aos secrets login cursor
aos: Unknown agent "cursor". Expected one of: claude, codex, opencode, pi.
```

Each exited with status 1.
