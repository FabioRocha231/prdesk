---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: []
---

# Surface: main window (triage board + PR detail)

Mode: Operate. A developer scans every open PR across repos many times a day and acts on whatever is waiting on them.

Task: see all states at once (overview first), pick a PR, read its review threads, and hand it to an agent in the embedded terminal. Frequency: all day, in short glances. Must not feel like GitHub, a generic SaaS dashboard, sparse, or noisy/anxious.

## Direction contract

THESIS: The PR inbox as a Swiss timetable. A rigid modular grid and one neutral grotesk. Signal red exists only where it is your turn. Refuses the category default: a dark slate sidebar app with colored pills on every row.

OWN-WORLD: White ground and true black type in light mode; inverted in dark mode (near-black ground, white type, same red). One grotesk in two weights (regular, bold), with mono only inside diff hunks. 1px black rules, no shadows, no rounded cards, no gradients. Square corners everywhere. Red (#e30613-family) is reserved for the "my turn" state and its count; every other state is weight, case, and position.

STORY: The user understands at a glance how many PRs wait on them and which ones. They trust each status because its proof (last actor + when) sits beside it. Then they open a PR and press `c` to send it to an agent.

FIRST VIEWPORT: A full-window 12-column grid. Top band: the wordmark "prdesk" at left, sync time and agent selector at right, separated by one rule. Below it, four columns: Sua vez / Review pedido / Aguardando / Outras. Each column has its count set huge in bold grotesk (red only for Sua vez), then rows at a single type size: repo · #n title, age, last actor, a one-line "what's needed". Rows in Sua vez also carry an excerpt of the triggering comment. Selecting a row reverses it to a black bar. The detail (threads with diff hunks, the agent button, then the terminal) takes over columns 7–12, and the board compresses to columns 1–6. The primary action is "Abrir no agente" (`c`) at the top of the detail.

Signature interaction: when a poll changes whose turn it is, the row moves to its new column with one translate along the grid (no fade) and the count ticks over. Motion: short, linear-feeling, grid-aligned. Reduced motion means an instant move.

Raises:
- From lexicon: rank by apparatus, not size.
- From timetable: one row type size; rank by weight, case, and reversal.
- From monochrome marketing: every status carries its proof.
- From character catalog: fixed furniture per PR (repo, age, last actor, what's needed).

FORM: Swiss International Typographic Style timetable/signage, position 6 on the grounded list. Seed key 95208749.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Unresolved

- Exact grotesk face (avoid the banned-defaults list; candidates to evaluate at build).
- Settings and onboarding surfaces inherit this world; not designed yet.
