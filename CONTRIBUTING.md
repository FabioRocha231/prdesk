# Contributing to prdesk

Thanks for helping. Issues and pull requests are welcome.

## Before you start

- For a bug, open an issue with the steps to reproduce and your OS.
- For a new feature, open an issue first so we can agree on the shape before you write code.

## Running it

```sh
pnpm install
pnpm dev          # UI only: http://localhost:1420/?mock shows synthetic data, no token needed
pnpm tauri dev    # the full app (needs Rust and the Tauri prerequisites for your OS)
```

Most UI work can be done in the `?mock` mode.

## Checks

The CI runs these; please run them before opening a PR:

```sh
pnpm typecheck && pnpm lint && pnpm test
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

## Conventions

- Code, comments, docs and commit messages in English. UI copy is in Brazilian Portuguese for now.
- Semantic commit messages: `feat(board): …`, `fix(settings): …`, `docs: …`.
- Keep pull requests small and focused on one change.
- Anything that touches the token, git or the shell belongs in Rust (`src-tauri/src/`). The token never reaches the webview.
- Pure logic (triage, dependencies, lanes) lives in `src/lib/` with a test next to it.
- Keyboard first, but every action must also work with the mouse.
