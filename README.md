# prdesk

Every open pull request across your repos in one window, sorted by **whose turn it is**. One key hands a PR to your AI agent, running in a ready worktree.

prdesk is a desktop app (macOS, Windows, Linux) built with Tauri. It runs entirely on your machine: no server, no telemetry. Your token stays in the OS keychain.

## What it does

- **One board, four columns.** *Sua vez* (your turn), *Review pedido* (review requested), *Aguardando* (waiting on others) and *Outras* (everything else in your scopes, folded to a strip). Columns can be reordered, resized and folded.
- **Proof next to every status.** Each card shows who acted last and when, plus flags for conflicts, failing CI, drafts and approvals.
- **The next step, one click away.** Inside a PR, one highlighted button says what to do now (review the files, resolve everything with the agent, merge, update the branch); the rest lives in *Mais*.
- **Review without leaving the app.** The full diff with line comments and "viewed" marks, review threads with their diff hunk, replies and resolve, the conversation, CI checks with re-run, and the PR's branch tree.
- **Open in your agent.** Pick Claude Code, Codex or OpenCode, or add your own, and press `c`. prdesk clones the repo once into `~/PRDesk`, creates a worktree for the PR's branch, and starts the agent in an embedded terminal with the context already in the prompt. The card shows whether the agent is working or waiting on you, and a notification tells you when it goes quiet.
- **AI on the side.** Analyze a PR (summary, risks, draft comments), draft replies, rewrite descriptions, or describe a task and get a new branch, the agent's work and a written PR.
- **Less to keep in your head.** *Novidades* (GitHub notifications), *Encadeadas* (PRs that declare "Depends on org/repo#123", in merge order), snooze until tomorrow, Monday or the next change, a daily summary to paste, auto-merge once CI passes, and a tray icon with your my-turn count.
- **Housekeeping.** Settings finds worktrees of closed PRs and removes the ones with nothing unsaved in them.

### How "whose turn" is decided

| PR | Your turn when… |
|---|---|
| Yours | an unresolved thread's last comment isn't yours · changes were requested after your last commit · CI is failing · someone commented after your last commit · it's approved (merge it) |
| Someone else's | someone answered a thread you started |

Someone else's PR goes to *Review pedido* when you are a requested reviewer, or when new commits landed after your review.

## Keyboard

| Key | Action |
|---|---|
| `j` / `k` | Next / previous PR |
| `Enter` | Open the highlighted PR |
| `c` | Open the selected PR in the agent |
| `o` | Open the selected PR on GitHub |
| `⌘K` / `Ctrl+K` | Search PRs |
| `n` | Novidades (notifications) |
| `p` | New PR with the agent |
| `t` | Branch tree |
| `r` | Refresh |
| `,` | Settings |
| `?` | Help |
| `Esc` | Close the PR / leave settings |
| `⌘⇧P` / `Ctrl+Shift+P` | Bring prdesk to the front from anywhere |

## Setup

1. Install from the [releases page](../../releases), or build it yourself (below).
2. On first launch, prdesk uses your GitHub CLI token if `gh auth login` was done. Otherwise, paste a token with the `repo` and `read:org` scopes.
3. Add the orgs (`acme`) and repos (`acme/api`) you want to follow. PRs that involve you appear even outside these scopes.

The agent commands are templates: `{prompt}` is replaced by prdesk's instructions. For example, `claude {prompt}` or `opencode --prompt {prompt}`. They run in your login shell, so whatever works in your terminal works here.

## Development

Requirements: Rust (stable), Node 22+, pnpm, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
pnpm install
pnpm tauri dev          # the app
pnpm dev                # UI only; open http://localhost:1420/?mock for synthetic data, no token needed
pnpm typecheck && pnpm lint && pnpm test
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

Architecture in one paragraph: the React UI (`src/`) builds the GraphQL queries and decides whose turn it is (`src/lib/triage.ts`, pure and tested). Rust (`src-tauri/src/`) owns everything that touches secrets or the machine:
- the keychain token (`auth.rs`)
- the GitHub HTTP call (`github.rs`)
- cloning and worktrees (`workspace.rs`)
- the PTY behind the embedded terminal (`pty.rs`)
- headless agent runs for the AI features (`agent.rs`)

The token never reaches the webview.

## Roadmap

- GitLab merge requests
- English UI (today the UI is in Brazilian Portuguese)
- Point at an existing local clone instead of the managed workspace

## License

MIT
