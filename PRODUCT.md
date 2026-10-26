# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Desktop app: the UI runs in the Tauri 2 webview on macOS, Windows and Linux. The design language is the app's own, not per-OS native.

## Stack

Tauri 2 (Rust core) + React + TypeScript frontend. Rust owns git (clone, worktree), the PTY for the embedded terminal, and secure token storage (OS keychain). There is no server: each user's machine talks to the code hosts directly.

## Users

Developers who have many open pull/merge requests across several orgs and repos and can no longer keep track of which ones need them right now. Many of them already work with AI coding agents (Claude Code, Codex, OpenCode). Some teammates dislike the CLI and must be able to do everything from the app. It's a public open-source project. The author and their multi-OS team (Windows, macOS, Linux) are the first users.

## Product Purpose

prdesk gathers every open PR/MR from the orgs and repos you configure into one inbox. It answers one question first: **what is waiting on me right now?** Every PR gets a "whose turn is it" status. From any PR, one click opens an AI agent in an isolated worktree with the context already loaded, so you can fix review comments or review someone else's PR. Success means the user stops tracking PRs by hand.

## Positioning

Code-host UIs and notification inboxes show *activity*. prdesk shows *whose turn it is*, across every repo at once, and turns "my turn" straight into an agent working in a ready worktree. Nothing in between needs a terminal.

## Operating Context

- Open all day next to the editor. Quick scans between tasks, with keyboard-first navigation (j/k to move, c to open in an agent).
- Data comes from GitHub GraphQL, polled periodically. Comment bodies come from the hosts' server-rendered HTML (GitHub `bodyHTML`).
- Review threads are shown with their diff hunk (file:line + code context) and the conversation underneath.
- The agent action creates or reuses a per-PR git worktree under a default workspace folder (`~/PRDesk/<owner>/<repo>-pr-<n>`). The base repo is cloned automatically on first use. Then the chosen agent starts in an embedded terminal pane inside the app.

## Capabilities and Constraints

- Hosts: GitHub (including Enterprise via a configurable API URL). GitLab is deferred to a tracked issue.
- Scope: all open PRs/MRs in the configured orgs/groups and repos, not just the user's own.
- Triage statuses:
  - **my turn**: unresolved thread whose last comment is not mine, or changes requested after my last push
  - **review requested**: someone asked me to review
  - **waiting on reviewer**
  - **no review yet**
  - **others**: doesn't involve me, collapsed by default
  - CI-failing and approved show as extra badges.
- Agents: Claude Code, Codex and OpenCode ship as defaults. Each one is an editable command template, so users can add other agents.
- Auth: personal tokens stored in the OS keychain. On GitHub, fall back to `gh auth token` when it's available. No backend, no telemetry.
- Deferred past v1: replying to and resolving threads from the app, notifications, pointing to an existing local clone instead of the managed workspace.

## Brand Commitments

Name: **prdesk**. Open source, MIT licensed.

## Evidence on Hand

None yet. Do not invent user counts, testimonials or benchmarks.

## Product Principles

1. Whose turn it is comes first; everything else is secondary.
2. Never require a terminal outside the app; the CLI is optional, not a prerequisite.
3. Local-first: tokens and code never leave the user's machine through prdesk.
4. Keyboard-first, but every action is also reachable by mouse.
5. The agent is the hand-off point. prdesk prepares the context and the agent does the work.

## Accessibility & Inclusion

No product-specific requirement established beyond WCAG AA basics: contrast, full keyboard operability, and status shown by more than color alone.
