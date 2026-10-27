# Missions: one task, several repos, several agents

Status: implemented (phases 1–3). The part terminal opens in the part's task view rather than docked in the mission screen.

## Problem

A change often spans repos: an API field in the back end and the screen that shows it, or the same migration across five services. Today the dev opens one terminal per repo, copies context between agents by hand, opens each PR on its own and forgets to link them. prdesk already has every piece for one repo (task → worktree → agent → PR) and for linking PRs (`Depende de org/repo#n`, *Encadeadas*). A mission ties them together.

## Goals

- Describe the work once, pick the repos, and get a plan that splits it per repo plus the **contract** between them (API shapes, event names, new fields).
- The plan lives in a file the dev can read and edit with any editor; the app treats that file as the source of truth.
- One agent per repo works in parallel, each with its part and the whole plan in context.
- One screen shows every repo's agent, who is waiting on the dev first, and opens all PRs at the end already linked in merge order.

## Non-goals

- Agents talking to each other, or a manager agent deciding on its own. The dev routes information between agents; the written contract keeps them aligned. Revisit only if real missions show the dev relaying the same kind of message over and over.
- Running the system end to end (back and front up together). Each agent tests its own repo; integration stays with the dev and CI.
- Missions on repos outside GitHub or outside the managed workspace.

## Vocabulary

- **Mission** (*Missão* in the UI): the multi-repo unit of work.
- **Part**: the mission's slice for one repo. A part is an existing `Task` with a `mission` id, so its worktree, agent session, diff view and "open PR" flow are the ones tasks already use.
- **Plan**: `plan.md`, the mission's source of truth.
- **Contract**: the plan section every part must honour.

## Files on disk

```
~/PRDesk/
  missions/
    2026-10-27-order-number-on-receipt/
      plan.md          # source of truth, edited by the dev (and the planning agent)
      mission.json     # app state: parts, branches, PR numbers, phase
  acme/
    api-prdesk-order-number-on-receipt/     # part worktree (existing prepare_branch layout)
      .prdesk/plan.md                       # copy of the plan, refreshed on "Propagar"
      .prdesk/notes.md                      # written by the agent, read by the app
    web-prdesk-order-number-on-receipt/
      .prdesk/plan.md
      .prdesk/notes.md
```

- The canonical plan lives outside every repo, so it is never committed by accident. Each worktree gets a **copy** in `.prdesk/` (already git-excluded by `exclude_prdesk`) because agents read files inside their cwd without extra permission prompts.
- `mission.json` holds only what the app needs to resume after a restart; anything a human should read goes in `plan.md`.
- `notes.md` is the agent's channel back: progress, questions, and contract change requests (below).

### `plan.md` format

Plain markdown with three fixed heading shapes the app parses; everything else is free text.

```markdown
# Mostrar o número do pedido no recibo

## Contrato

- `GET /orders/:id` passa a devolver `orderNumber: string` (formato `PED-000123`).
- O campo é obrigatório a partir desta versão; o front não precisa de fallback.

## acme/api

Adicionar `orderNumber` ao serializer de pedido e à migração...

## acme/web
Depende de: acme/api

Mostrar `orderNumber` no recibo e no e-mail...
```

- `## Contrato` (or `## Contract`): required, may be empty.
- `## owner/repo`: one per part. The app derives the parts from these headings, so adding or removing a repo is editing the file.
- `Depende de: owner/repo[, …]` as the first line of a part: merge order. It becomes the `Depende de org/repo#n` line in that PR's description.

Parsing is a pure function (`parsePlan(text) → { title, contract, parts: { repo, dependsOn, body }[] }`) with unit tests; a plan that fails to parse shows the error inline and blocks launching, never silently drops a part.

### Contract change requests

An agent that needs to change the contract must not just do it. The launch prompt tells it to append to `.prdesk/notes.md`:

```markdown
## CONTRACT CHANGE
`orderNumber` precisa ser `number`, o banco já guarda como inteiro.
```

and stop. The app watches for that heading (on each `notes.md` read, see Sync) and raises the part to *Aguardando você* with the request shown on its card. The dev edits `plan.md`, then **Propagar plano** copies it into every worktree and types a short line into every running agent's terminal: `O plano mudou: releia .prdesk/plan.md e ajuste o que for preciso.` (`ptyWrite` already exists.)

## Flow

1. **New mission** (`M`, or *Missões → Nova missão*): the dev writes what needs to happen and picks the repos (multi-select over known repos, same list the task dialog uses).
2. **Plan**: a headless agent (`agent_run`, the AI features' path) gets the request and a short summary of each repo (default branch README head, top-level tree) and writes `plan.md`. The mission opens on the *Plano* tab showing the file. The dev edits it in the app or opens it in their editor; the app re-reads the file when the window regains focus.
3. **Launch**: *Iniciar N agentes* states the count before anything runs. For each part, the app runs `prepare_branch` (branch `prdesk/<mission-slug>`), writes `.prdesk/plan.md`, and spawns the agent with a prompt that names its part and the contract rules. Parts launch in parallel; a failed worktree marks only its card as failed, with *Tentar de novo*.
4. **Work**: the mission screen lists parts sorted by attention (see Screen). The dev opens one to see its terminal and diff; everything a task view does works here.
5. **Deliver**: *Abrir PRs* is enabled when every part has changes. Parts open in dependency order (topological sort of `Depende de`; a cycle is a plan error). Each PR gets its AI-written title and description plus `Depende de org/repo#n` for its dependencies, so the PRs show up linked on the board and in *Encadeadas* with no new code there.
6. **Done**: once every PR is merged or closed the mission moves to *Concluídas*; its folder stays until the dev removes it, like worktrees in Settings housekeeping.

## Screen

A new top-level view, next to *Árvore* and *Encadeadas* in the header.

```
┌ Missões ──────────────────────────────────────────────────────────────────────────────┐
│ Mostrar o número do pedido no recibo                          Plano · Execução · PRs  │
│ 3 repos · 2 trabalhando · 1 aguardando você                 [Propagar plano] [Abrir PRs]│
├──────────────────────────────┬────────────────────────────────────────────────────────┤
│ ● Aguardando você            │  Plano   Notas   Mudanças                               │
│   acme/web                   │                                                         │
│   pediu mudança de contrato  │  ## Contrato                                            │
│   "orderNumber precisa ser…" │  - GET /orders/:id passa a devolver orderNumber: string │
│                              │  …                                                      │
│ ● Trabalhando                │  ## acme/web                                            │
│   acme/api      +84 −12  3m  │  Depende de: acme/api                                   │
│   acme/mobile   +20 −3   1m  │  …                                                      │
│                              │                                   [Salvar] [Abrir no editor]│
│ ○ Pronto                     ├────────────────────────────────────────────────────────┤
│   (nenhum)                   │ >_ Claude Code · acme/web                     Encerrar  │
│                              │ (terminal da parte selecionada)                         │
└──────────────────────────────┴────────────────────────────────────────────────────────┘
```

- **Left rail**: one card per part, grouped *Aguardando você* (agent quiet, contract change request, failed) → *Trabalhando* → *Pronto* (agent exited with changes) → *Com PR*. The same rule as the board: what needs the dev comes first. `J`/`K` move between parts, `Enter` opens one, `C` focuses its terminal.
- **Main area**: tabs *Plano* (the canonical file, editable), *Notas* (the selected part's `notes.md`), *Mudanças* (its diff, the existing Changes view). The terminal docks below, as inside a PR.
- **Header strip on the board**: a running mission shows as one chip in the existing strips row (*Missão: Mostrar o número… · 1 aguardando você*), so it is visible without switching views.
- Notifications reuse `notifyAgentQuiet`, prefixed with the mission title.

## Architecture

Most of it is UI over existing commands.

| Need | How |
|---|---|
| Worktree per part | `prepare_branch`, unchanged |
| Agent per part | `spawnAgent` keyed by the part's task id, unchanged |
| Planning agent | `agent_run` in the first part's worktree (needs a git repo for `.prdesk/`) |
| Agent quiet / exited | existing `Session` states |
| Diff per part | `worktree_changes` |
| Open PRs | `commitAndPush` + `createPull`, called in dependency order |
| Tell agents the plan changed | `ptyWrite` |
| **New:** read/write mission files | Rust commands `mission_list`, `mission_read(id, file)`, `mission_write(id, file, text)`, limited to `<workspace>/missions/<id>/{plan.md,mission.json}`; `id` is a slug checked like `valid_ref` |
| **New:** copy plan into worktrees, read notes | `write_agent_context` generalized to take the file name (`plan.md` or `context.md`), plus `read_agent_notes(path)`; both stay inside `inside_workspace` |

The token never reaches the webview; the new Rust commands touch only files under the workspace.

### State

- `Task` gains `mission?: string`. Parts are tasks, so the existing tasks strip, task view, persistence and the move of a task's session onto its PR all keep working.
- `mission.json`: `{ id, title, createdAt, phase: "planning" | "running" | "delivering" | "done", parts: { repo, taskId, branch, pr?: number }[] }`.
- **Sync**: the app re-reads `plan.md` and every `notes.md` when the mission view opens, on window focus, and every 30s while a mission is running. That is polling a few small local files; no file watcher until it proves too slow.

## Costs and risks

- **Attention**: five agents can stop at once. The attention-sorted rail and the board chip are the mitigation; the mission does not try to answer for the dev.
- **Tokens**: N parallel agents. The launch button states N; no auto-retry of a failed agent.
- **Contract drift**: the main failure mode. Mitigated by the contract section, the change-request protocol and *Propagar plano*. A later phase may add *Checar integração*: one headless pass that reads every part's diff against the contract and lists mismatches.
- **Plan file edited while agents run**: agents only see a change after *Propagar*. The mission header shows *Plano alterado, não propagado* when the canonical file differs from the copies.

## Phases

1. **Plan and launch**: Rust mission file commands, `parsePlan` with tests, new-mission dialog, planning agent, the mission view with the plan editor and part cards, launching parts as tasks.
2. **Run**: attention-sorted rail, notes tab, contract change requests, *Propagar plano*, the board chip and notifications.
3. **Deliver**: dependency-ordered *Abrir PRs* with `Depende de` links, *Concluídas*, and the optional *Checar integração*.

Each phase ships on its own: after phase 1 a mission is already useful (parallel agents from one plan), just with less help coordinating them.

## Open questions

- Name: *Missão* reads well in pt-BR and does not clash with *Tarefa*; alternatives are *Épico* and *Tarefa multi-repo*.
- Should one part be allowed to point at a repo that has no worktree yet but already has an open PR, so a mission can adopt work in progress? Out of phase 1; easy to add since parts are tasks.
