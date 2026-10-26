# prdesk

Every open pull request across your repos in one window, sorted by **whose turn it is**. One key hands a PR to your AI agent, running in a ready worktree.

prdesk is a desktop app (macOS, Windows, Linux) built with Tauri. It runs entirely on your machine: no server, no telemetry. Your token stays in the OS keychain.

## What it does

- **One board, four columns.** *Sua vez* (your turn), *Review pedido* (review requested), *Aguardando* (waiting on others) and *Outras* (everything else in your scopes).
- **Proof next to every status.** Each row shows who acted last and when. Rows that are your turn also quote the comment that is waiting on you.
- **Review threads, rendered.** Each thread shows the diff hunk it was left on and the conversation under it, plus the general comments and the description.
- **Open in your agent.** Pick Claude Code, Codex or OpenCode, or add your own, and press `c`. prdesk clones the repo once into `~/PRDesk`, creates a worktree for the PR's branch, and starts the agent in an embedded terminal with the context already in the prompt. You never need a separate terminal.

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
| `r` | Refresh |
| `,` | Settings |
| `Esc` | Close the PR / leave settings |

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
cd src-tauri && cargo clippy && cargo test
```

Architecture in one paragraph: the React UI (`src/`) builds the GraphQL queries and decides whose turn it is (`src/lib/triage.ts`, pure and tested). Rust (`src-tauri/src/`) owns everything that touches secrets or the machine:
- the keychain token (`auth.rs`)
- the GitHub HTTP call (`github.rs`)
- cloning and worktrees (`workspace.rs`)
- the PTY behind the embedded terminal (`pty.rs`)

The token never reaches the webview.

## Roadmap

- GitLab merge requests
- Reply to and resolve threads from the app
- Clean up worktrees when a PR closes
- Point at an existing local clone instead of the managed workspace

## License

MIT
