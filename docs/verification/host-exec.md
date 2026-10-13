# Verification: private session git directory

Manual end-to-end checks for worktree sessions (the host-execution work described in
[../security.md](../security.md)). They need Docker, the network (npm and the pre-commit image layer) and a
scratch `AOS_ROOT`; they never touch `~/AgenticOS/secrets`, your real repositories or your default treehouse
pool. Run them with a lab-only image tag (edit `IMAGE` in `src/docker.ts` in a scratch copy) so your own
`aos-dev:local` is not replaced.

Results below are from the build of this change, on macOS with Docker Desktop 29.8.2, host git 2.54.0, image git
2.39.5, treehouse v2.3.0, Node 24.16.0, husky 9.1.7, lefthook 2.2.1 and pre-commit 4.7.0 (the version the image
installs). Every launch is the real aos path (Sandcastle, the real image and mounts, treehouse lease, import,
container removal). To run without a person at a terminal, the scratch copy replaced only the agent CLI with a
shell script (`AOS_LAB_COMMAND`) and ran `aos` under a pseudo terminal.

## Setup

For each repository, the approved Mac-side setup is made by the manager's own installer **inside a container**, so
no package code runs on the Mac. Every approved check script touches `HOST_APPROVED_<repo>` only on macOS and every
agent-added script touches `HOST_RAN_AGENT_LINT_<repo>` only on macOS, so a marker means "ran on the Mac".

| Repository | Approved setup |
|---|---|
| `husky` | `npm install` (husky `prepare`): `core.hooksPath=.husky/_` and its stubs |
| `lefthook` | `npm install` and `lefthook install`: a `hooks/pre-commit` shim |
| `precommit` | `pre-commit install`, then the shim's `INSTALL_PYTHON` rewritten to a Homebrew path that does not exist in the container (a Mac-style shim) |
| `custom` | `core.hooksPath=.githooks`, in-tree script |
| `custom2` | a copy-installer (`git rev-parse --git-path hooks`) that writes `.git/hooks/pre-commit` |

## Scenario per repository

One launch (`aos pi`), the agent-side steps, then host checks, then a resume (`aos pi -c`).

| Step | husky | lefthook | pre-commit | custom hooksPath | custom installer |
|---|---|---|---|---|---|
| Launch-time missing-runner line | printed once when `.husky/_` was absent | printed (no `node_modules` yet) | none (runner is in the image) | none | none |
| 1. dependency install / hook setup | `npm install` rc 0, stubs written **in the session** | `npm install` + `lefthook install` rc 0 | `pre-commit install` rc 0 | nothing to install | installer wrote the session's hook |
| 2. agent commit runs the hook in the container | `HOOK-RAN husky check on Linux`, rc 0 | `✔️ check`, rc 0 | `check Passed`, rc 0 | `HOOK-RAN custom ... on Linux`, rc 0 | same, rc 0 |
| 3. a failing hook stays visible | `husky - pre-commit script failed (code 1)`, commit rc 1 | `🥊 check`, rc 1 | `check Failed`, rc 1 | rc 1 | rc 1 |
| 4. agent edits the hook setup (adds `scripts-lint.sh`) | both ran, rc 0 | `check` and `lint` ran | `check` and `lint` Passed | both ran | re-installed, both ran |
| 5. writes toward the repository's `.git` (`config`, `hooks/pre-commit`, `commondir`, `refs/heads/main`, `objects/planted`, a new directory) | all refused | all refused | all refused | all refused | all refused |
| 6. agent plants `core.fsmonitor`, a clean filter, `info/attributes` and a `post-checkout` hook in its session git dir | done | done | done | done | done |
| First agent commit visible on the Mac while the session ran | 4 s | 4 s | 4 s | 2 s | 3 s |
| Imported commits on the session branch | `a`, `add lint hook` | same | same | same | same |
| Repository's config, hooks, info and refs (sha256) before and after | unchanged | unchanged | unchanged | unchanged | unchanged |
| Host markers after `aos worktree list` and a plain `git status` in the worktree and in the main checkout | none | none | none | none | none |
| Resume (`aos pi -c`): same session git dir reused, `hooksPath` kept, the agent's own planted config still only inside the session, incremental import | yes | yes | yes | yes | yes |
| Host markers at the end of the resume | none | none | none | none | none |

Further checks:

- **`aos worktree merge`, then `rm`** on `custom`: the merge imported nothing new (live import had run), merged
  the agent's commits, `rm` refused the dirty worktree, `rm --force` returned the lease from aos's pool,
  removed the branch and the session git dir. No markers.
- **Mac-style pre-commit shim copied into the session, no `pre-commit install`**: the commit passed. The shim's
  baked `INSTALL_PYTHON` does not exist in the container, and it falls back to `pre-commit` on `PATH`.
- **`git gc` and `git fsck` in a session** with read-only alternates: both rc 0.
- **Pull and push**, with a local bare repository standing in for GitHub (mounted into the container by the
  scratch copy only): a teammate commit on `origin` and an unpushed commit on the Mac. In the session,
  `git fetch origin` saw the teammate commit, `git fetch host` showed `host/main` as the Mac's unpushed commit,
  `git pull --rebase origin main` replayed the session commit on top of both, `git push origin` succeeded,
  `touch /mnt/aos-host-git/probe` failed with `Read-only file system`, and the imported session branch contained
  the teammate's commit and the Mac's.
- **GitHub repository pin** (`aos pi --here`, a throwaway App key, no network call made): the first launch wrote
  `{"owner":"lab","name":"custom"}`; after `git remote set-url origin .../some-other-private-repo.git` the session
  got no spool and a status message naming both repositories; after deleting the pin file the next launch
  pinned the new origin.
- **Dubious ownership.** The mount root of a bind mount is not owned by the agent user, so git refuses it unless
  it is listed in `safe.directory`. aos passes the project mount and the session git dir through
  `GIT_CONFIG_*` for the session. Git's local transport drops those, so the read-only `/mnt/aos-host-git`
  (`git fetch host`) is trusted in the image's `/etc/gitconfig` instead; before that was added `git fetch host`
  failed with `detected dubious ownership`.

## Not measured

- Timing on a large repository (the earlier scout measured 0.3 s to create a session git directory, 0.2 s for an
  empty import and 5.2 MB per session on vite).
- Submodule repositories, partial clones and LFS (see "Not supported" in the security doc).
- A real GitHub push (needs the GitHub App; the credential helper path is unchanged by this work).
- A real interactive agent CLI (the agent was replaced by a script; everything around it was real).
- A crashed session whose import is pending: covered by unit tests with a fake `docker`, not a real container.

## Unit tests

```sh
npm run typecheck
node --test test/sessiongit.test.ts test/hookrunners.test.ts test/worktreeCli.test.ts test/github.test.ts
npm test
```
