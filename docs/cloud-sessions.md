# Cloud sessions: one-time setup

Three RouteIQ work streams run as Claude Code cloud sessions (claude.ai/code) instead of on
the PC: design (#21), the native app (#15) and the e2e scenarios (#32). The orchestrator
stays a local CLI session. How cloud sessions report back is in CLAUDE.md,
"Coordination" > "Cloud sessions".

Facts below were checked on 2026-11-11 against:
[Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web),
[Cloud environments](https://code.claude.com/docs/en/cloud-environments) and
[Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging).

## What the cloud gives you

- The VM is Ubuntu 24.04. The setup script runs as root before Claude Code starts, must
  exit 0 and finish in about five minutes, and its result is cached for about seven days
  (rebuilt when you change the script or the allowed hosts).
- The image has Node 20/21/22 (22 by default), `gh`, git and Chrome for Testing. It has no
  Node 24, no Playwright browser and no Swift, so `scripts/cloud-setup.sh` installs them.
- The repo's `.claude/settings.json` is used in the cloud, so its SessionStart hook
  (`cloud-setup.sh session`) runs at every session start: it puts Node 24 on PATH and runs
  `npm ci` and the Playwright install only when they are out of date. Locally the hook does
  nothing (it checks `CLAUDE_CODE_REMOTE`). Your user-level `~/.claude` settings and the
  fleet mod don't reach the cloud.
- GitHub goes through Anthropic's GitHub proxy. `git push` of a branch works. `gh api` works,
  but `gh issue` and `gh pr` don't (the proxy rejects GraphQL), so the skills use `gh api`.
- Cloud sessions can't message local sessions. They report as comments on #17 and through
  their PRs, and the orchestrator reads both.

## 1. Connect GitHub

Open https://claude.ai/code and follow the prompt to install the **Claude GitHub app** on
`akashdesai93/routeiq` (only that repo is enough). Alternatively, run `/web-setup` in a local
Claude Code session to use your local `gh` login.

Recommended: a GitHub branch ruleset on `main` that blocks direct pushes, because the proxy
doesn't limit which branches a push can update.

## 2. Create the environment

In claude.ai/code, open the environment picker, choose **Add environment**, and set:

- **Name:** `routeiq`
- **Network access:** Limited, with **Allow package managers** checked (the default). The
  default list already has registry.npmjs.org, github.com, the GitHub content hosts,
  swift.org and the Ubuntu archives. Add these under **Allowed domains**, one per line:

  ```
  nodejs.org
  cdn.playwright.dev
  playwright.download.prss.microsoft.com
  playwright.azureedge.net
  download.swift.org
  ```

- **Setup script:** paste the whole of
  [`scripts/cloud-setup.sh`](https://github.com/akashdesai93/routeiq/blob/main/scripts/cloud-setup.sh)
  (use the "Raw" view to copy it). It installs Node 24, then `npm ci` and headless Chromium
  if the repo is already checked out. The SessionStart hook covers it if not.
- **Environment variables:** none. **Do not add the Mapbox token.** The unit tests and the
  e2e build use a dummy `pk.test` token and answer every outside request themselves, so no
  session needs the real one. Environment variables are readable by anyone who uses the
  environment.

**Native (#15), optional second environment:** duplicate it as `routeiq-native` and change
`INSTALL_SWIFT="${INSTALL_SWIFT:-0}"` to `INSTALL_SWIFT=1` near the top of the pasted script,
so Swift 6.4.2 (the version native-core.yml gets on ubuntu-24.04) is installed once and
cached. Without it, the native session runs `bash scripts/cloud-setup.sh swift` itself
(a few minutes, every new session), then `export PATH=/opt/swift/usr/bin:$PATH`.
Only `native/RouteIQCore` builds on Linux. The app target still needs the macOS CI build.

## 3. Post the handoff comments

Each session starts from a handoff comment on its issue. #32 has one (posted 2026-11-11).
#21 and #15 need one before their session starts: ask the orchestrator to post it (state,
branch, files, next step, open questions).

## 4. Start the three sessions

**From the web (lets you pick the environment):** https://claude.ai/code, choose the
`akashdesai93/routeiq` repo, branch `main`, the environment, and paste the prompt.

**From the terminal:** `claude --cloud` (the older `--remote` still works) clones the
GitHub remote of the current directory **at the current branch**, so run it from a checkout
that is on `main` and up to date. It uses your default environment; there is no flag to
choose a hosted one, so use the web for `routeiq-native`.

```bash
cd C:\Users\akash\dev\routeiq        # on main, pulled
claude --cloud "Read CLAUDE.md, then the handoff comment on #21, then continue."   # design
claude --cloud "Read CLAUDE.md, then the handoff comment on #15, then continue."   # native (or the web, with routeiq-native)
claude --cloud "Read CLAUDE.md, then the handoff comment on #32, then continue."   # e2e
```

Follow-ups: `claude -p "<message>" --cloud <session-id>`. To continue one locally, run
`/teleport` (or `claude --teleport <session-id>`) from a clean checkout of this repo, signed
in to the same claude.ai account; the cloud branch must be pushed first.

## 5. Stop the old desktop sessions

Once a cloud session has posted its first `status:` comment on #17, stop the matching
desktop session and leave its worktree for the orchestrator's hygiene step (it removes
clean worktrees whose PR merged or closed; it never touches a dirty one).
