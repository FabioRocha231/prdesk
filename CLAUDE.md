# prdesk

Tauri 2 desktop app: React + TypeScript UI in `src/`, Rust core in `src-tauri/src/`. See README.md for the product and architecture.

## Commands

```sh
pnpm dev                 # UI only, open http://localhost:1420/?mock for synthetic data
pnpm tauri dev           # the native app
pnpm typecheck && pnpm lint && pnpm test
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

CI runs all of the above; keep it green before pushing.

## Conventions

- Code, comments, docs and commit messages in English; UI copy in pt-BR.
- Semantic commit messages (`feat(scope): …`, `fix(scope): …`).
- Secrets and the machine stay in Rust: the token never reaches the webview.
- Keyboard first, but every action must also be reachable by mouse.

<!-- engineering-learn:live -->
## Learned rules

- When a keyboard shortcut or action starts working from a new view, check that its result is visible from that view (e.g. the agent terminal only docks inside a PR, so starting an agent from the board must open the PR first).
<!-- /engineering-learn:live -->
