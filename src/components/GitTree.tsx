import { open } from "@tauri-apps/plugin-dialog";
import { ChevronRight, FolderOpen, GitBranch, GitMerge, GitPullRequest, RefreshCw, Tag } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";

import type { Config } from "../lib/config";
import { age } from "../lib/format";
import { type Edge, layoutGraph, mainlineTip, mergedPr, readRefs, remoteSlug } from "../lib/graph";
import {
  errorMessage,
  type Graph,
  type GraphCommit,
  gitFetch,
  gitGraph,
  gitRepos,
  prGraph,
  type RepoEntry,
} from "../lib/ipc";
import type { PullRequest } from "../lib/model";
import { loadValue, saveValue } from "../lib/persist";

const ROW_H = 30;
const LANE_W = 16;
const PAD = 12;
const NODE_R = 4.5;
const LANE_COLORS = 6;
const DIR_LIMIT = 400;
const PR_LIMIT = 200;
const MAX_RECENT_DIRS = 6;
const RECENT_KEY = "treeDirs";
// Related branches drawn next to a PR: stacked PRs on either side. Bounded so one fetch stays small.
const MAX_RELATED = 8;

const laneX = (lane: number): number => PAD + lane * LANE_W;
const rowY = (row: number): number => row * ROW_H + ROW_H / 2;
const laneColor = (lane: number): string => `var(--lane-${lane % LANE_COLORS})`;

/** Leaves the node, curves into its lane, runs down, curves into the parent's lane. */
function edgePath(e: Edge): string {
  const x1 = laneX(e.fromLane);
  const xv = laneX(e.via);
  const xt = laneX(e.toLane);
  const y1 = rowY(e.from);
  const y2 = rowY(e.to);
  if (e.to - e.from === 1) return `M${x1} ${y1} C${x1} ${y1 + ROW_H / 2} ${xt} ${y2 - ROW_H / 2} ${xt} ${y2}`;
  const out = `M${x1} ${y1} C${x1} ${y1 + ROW_H * 0.6} ${xv} ${y1 + ROW_H * 0.4} ${xv} ${y1 + ROW_H}`;
  const run = `L${xv} ${y2 - ROW_H}`;
  const join = `C${xv} ${y2 - ROW_H * 0.4} ${xt} ${y2 - ROW_H * 0.6} ${xt} ${y2}`;
  return `${out} ${run} ${join}`;
}

interface PrBadge {
  number: number;
  base: string;
  draft: boolean;
}

/**
 * A commit graph in the GitKraken shape: lanes on the left, refs and subject on the right. Branches with an
 * open PR show where they merge to; merged PRs show in GitHub's purple.
 */
export function GitTree({
  graph,
  prs,
  focus,
  onOpenPr,
}: {
  graph: Graph;
  /** Open PRs of this repository, to label their head branches. */
  prs: PullRequest[];
  /** In a PR's own tree, its head is fetched as origin/pr/<n>. */
  focus?: { number: number; base: string; draft: boolean };
  onOpenPr: (number: number) => void;
}): ReactElement {
  const layout = useMemo(
    () => layoutGraph(graph.commits, mainlineTip(graph.commits, focus?.base ?? null)),
    [graph, focus?.base],
  );
  const byHead = useMemo(
    () =>
      new Map(prs.map((p): [string, PrBadge] => [p.headRef, { number: p.number, base: p.baseRef, draft: p.isDraft }])),
    [prs],
  );
  const svgWidth = PAD * 2 + Math.max(0, layout.width - 1) * LANE_W;
  const height = graph.commits.length * ROW_H;
  const focusRow =
    focus === undefined
      ? -1
      : graph.commits.findIndex((c): boolean => readRefs(c.refs).some((r) => r.name === `pr/${focus.number}`));

  if (graph.commits.length === 0) return <p className="tree-empty">Nenhum commit para mostrar.</p>;

  const prFor = (name: string): PrBadge | undefined => {
    if (focus !== undefined && name === `pr/${focus.number}`) return focus;
    return byHead.get(name);
  };

  return (
    <div className="tree" style={{ ["--tree-gutter" as string]: `${svgWidth}px` }}>
      <svg className="tree-svg" width={svgWidth} height={height} aria-hidden>
        {layout.edges.map(
          (e, i): ReactElement => (
            <path
              // biome-ignore lint/suspicious/noArrayIndexKey: edges are recomputed with the graph and never reorder
              key={i}
              d={edgePath(e)}
              // The line takes the color of the branch it runs in.
              stroke={laneColor(e.via)}
              className={e.to >= graph.commits.length ? "tree-edge is-cut" : "tree-edge"}
            />
          ),
        )}
        {graph.commits.map((c, row): ReactElement => {
          const lane = layout.lanes[row] ?? 0;
          return (
            <circle
              key={c.hash}
              cx={laneX(lane)}
              cy={rowY(row)}
              r={c.parents.length > 1 ? NODE_R - 1.5 : NODE_R}
              className={
                row === focusRow ? "tree-node is-focus" : c.parents.length > 1 ? "tree-node is-merge" : "tree-node"
              }
              style={{ ["--node" as string]: laneColor(lane) }}
            />
          );
        })}
      </svg>
      <ol className="tree-rows">
        {graph.commits.map(
          (c): ReactElement => (
            <TreeRow key={c.hash} commit={c} prFor={prFor} onOpenPr={onOpenPr} />
          ),
        )}
      </ol>
    </div>
  );
}

function TreeRow({
  commit,
  prFor,
  onOpenPr,
}: {
  commit: GraphCommit;
  prFor: (branch: string) => PrBadge | undefined;
  onOpenPr: (number: number) => void;
}): ReactElement {
  const merged = mergedPr(commit.subject);
  return (
    <li className="tree-row" title={`${commit.hash.slice(0, 8)} · ${commit.author}`}>
      <span className="tree-refs">
        {readRefs(commit.refs).map((ref): ReactElement => {
          const pr = prFor(ref.name);
          if (pr !== undefined) {
            return (
              <button
                type="button"
                key={ref.name}
                className={pr.draft ? "tree-pill pr-draft" : "tree-pill pr-open"}
                title={`PR #${pr.number}: quando mesclar, vai para ${pr.base}`}
                onClick={(): void => onOpenPr(pr.number)}
              >
                <GitPullRequest size={12} strokeWidth={2} aria-hidden />#{pr.number}
                <span className="tree-arrow">→ {pr.base}</span>
              </button>
            );
          }
          return (
            <span key={`${ref.kind}:${ref.name}`} className={`tree-pill ref-${ref.kind}`}>
              {ref.kind === "tag" ? (
                <Tag size={11} strokeWidth={2} aria-hidden />
              ) : (
                <GitBranch size={11} strokeWidth={2} aria-hidden />
              )}
              {ref.name}
            </span>
          );
        })}
        {merged !== null && (
          <button
            type="button"
            className="tree-pill pr-merged"
            title={`PR #${merged} mergeada`}
            onClick={(): void => onOpenPr(merged)}
          >
            <GitMerge size={12} strokeWidth={2} aria-hidden />#{merged}
          </button>
        )}
      </span>
      <span className="tree-subject">{commit.subject}</span>
      <span className="tree-author">{commit.author}</span>
      <span className="tree-age">{age(new Date(commit.time * 1000).toISOString())}</span>
    </li>
  );
}

type Load =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; graph: Graph }
  | { status: "error"; message: string };

/** A PR's tree: its base, its head and stacked PRs around it, from the workspace clone. */
export function PrTree({
  config,
  pr,
  repoPulls,
  onOpenPr,
}: {
  config: Config;
  pr: PullRequest;
  /** Other open PRs in the same repo. */
  repoPulls: PullRequest[];
  onOpenPr: (number: number) => void;
}): ReactElement {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [owner = "", repo = ""] = pr.repo.split("/");
  const stacked = repoPulls
    .filter((p): boolean => p.id !== pr.id && (p.baseRef === pr.headRef || p.headRef === pr.baseRef))
    .slice(0, MAX_RELATED);
  const branches = stacked.map((p): string => p.headRef).join("\n");

  useEffect((): void => {
    setLoad({ status: "loading" });
    prGraph({
      repoUrl: pr.repoUrl,
      owner,
      repo,
      number: pr.number,
      baseRef: pr.baseRef,
      branches: branches === "" ? [] : branches.split("\n"),
      workspaceDir: config.workspaceDir,
      limit: PR_LIMIT,
    })
      .then((graph): void => setLoad({ status: "ready", graph }))
      .catch((e: unknown): void => setLoad({ status: "error", message: errorMessage(e) }));
  }, [pr.repoUrl, owner, repo, pr.number, pr.baseRef, branches, config.workspaceDir]);

  if (load.status === "error") return <p className="tree-empty">Não consegui montar a árvore: {load.message}</p>;
  if (load.status !== "ready") return <p className="tree-empty">Buscando a branch base e a PR…</p>;
  return (
    <GitTree
      graph={load.graph}
      prs={stacked}
      focus={{ number: pr.number, base: pr.baseRef, draft: pr.isDraft }}
      onOpenPr={onOpenPr}
    />
  );
}

/** One repository of the folder: header with its PR count, the tree once opened. */
function RepoSection({
  entry,
  prs,
  open: initiallyOpen,
  version,
  onOpenPr,
}: {
  entry: Entry;
  /** Open PRs on the board for this repo. */
  prs: PullRequest[];
  open: boolean;
  /** Bumped after a fetch, so an open section reads its history again. */
  version: number;
  onOpenPr: (number: number) => void;
}): ReactElement {
  const [open, setOpen] = useState(initiallyOpen);
  const [load, setLoad] = useState<Load>({ status: "idle" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the re-read trigger after a fetch
  useEffect((): void => {
    if (!open) return;
    setLoad({ status: "loading" });
    gitGraph(entry.path, DIR_LIMIT)
      .then((graph): void => setLoad({ status: "ready", graph }))
      .catch((e: unknown): void => setLoad({ status: "error", message: errorMessage(e) }));
  }, [open, entry.path, version]);

  return (
    <section className="repo" aria-label={entry.name}>
      <button type="button" className="repo-head" aria-expanded={open} onClick={(): void => setOpen(!open)}>
        <ChevronRight className="repo-chevron" size={15} strokeWidth={2} aria-hidden />
        <span className="repo-name">{entry.name}</span>
        {entry.slug !== null && entry.slug !== entry.name && <span className="repo-slug">{entry.slug}</span>}
        {prs.length > 0 && (
          <span className="tree-pill pr-open">
            <GitPullRequest size={12} strokeWidth={2} aria-hidden />
            {prs.length} {prs.length === 1 ? "PR aberta" : "PRs abertas"}
          </span>
        )}
      </button>
      {open && (
        <div className="repo-body">
          {load.status === "loading" && <p className="tree-empty">Lendo o histórico…</p>}
          {load.status === "error" && <p className="tree-empty">{load.message}</p>}
          {load.status === "ready" && <GitTree graph={load.graph} prs={prs} onOpenPr={onOpenPr} />}
        </div>
      )}
    </section>
  );
}

type Entry = RepoEntry & { slug: string | null };

/**
 * A folder with one or many repositories (e.g. a product's whole environment): every repo becomes a section with
 * its tree; repos with open PRs on the board come first and open.
 */
export function TreeView({
  pulls,
  onOpenPr,
}: {
  pulls: PullRequest[];
  onOpenPr: (repo: string, number: number) => void;
}): ReactElement {
  const [dirs, setDirs] = useState<string[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [repos, setRepos] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect((): void => {
    loadValue<string[]>(RECENT_KEY, [])
      .then((saved): void => {
        const list = Array.isArray(saved) ? saved.filter((d): d is string => typeof d === "string") : [];
        setDirs(list);
        if (list[0] !== undefined) setPath(list[0]);
      })
      .catch((): void => {
        // Degraded: no store (plain browser); the user picks a folder.
      });
  }, []);

  useEffect((): void => {
    if (path === null) return;
    setRepos(null);
    setError(null);
    gitRepos(path)
      .then((found): void => setRepos(found.map((r): Entry => ({ ...r, slug: remoteSlug(r.remote) }))))
      .catch((e: unknown): void => setError(errorMessage(e)));
  }, [path]);

  const choose = (dir: string): void => {
    const next = [dir, ...dirs.filter((d): boolean => d !== dir)].slice(0, MAX_RECENT_DIRS);
    setDirs(next);
    setPath(dir);
    saveValue(RECENT_KEY, next).catch((): void => {
      // Degraded: the folder still opens; it just will not be remembered.
    });
  };

  const pick = async (): Promise<void> => {
    const dir = await open({ directory: true, multiple: false, title: "Escolha uma pasta com repositórios" });
    if (typeof dir === "string") choose(dir);
  };

  const prsOf = (slug: string | null): PullRequest[] =>
    slug === null ? [] : pulls.filter((p): boolean => p.repo.toLowerCase() === slug.toLowerCase());

  // Repos with open PRs first, busiest first; then the rest by name.
  const sorted = [...(repos ?? [])].sort(
    (a, b): number => prsOf(b.slug).length - prsOf(a.slug).length || a.name.localeCompare(b.name),
  );

  // One repo at a time: a dozen parallel fetches would fight over the network and the user's SSH agent.
  const fetchAll = async (): Promise<void> => {
    const failed: string[] = [];
    for (const r of sorted) {
      setFetching(r.name);
      try {
        await gitFetch(r.path);
      } catch {
        failed.push(r.name);
      }
    }
    setFetching(null);
    setError(failed.length === 0 ? null : `Não consegui buscar: ${failed.join(", ")}`);
    setVersion((v): number => v + 1);
  };

  return (
    <section className="tree-view" aria-label="Árvore dos repositórios">
      <header className="tree-bar">
        <button type="button" className="tree-pick" onClick={(): void => void pick()}>
          <FolderOpen size={15} strokeWidth={2} aria-hidden /> {path === null ? "Escolher pasta" : "Trocar pasta"}
        </button>
        {dirs.map(
          (d): ReactElement => (
            <button
              type="button"
              key={d}
              className="tree-dir"
              aria-pressed={d === path}
              title={d}
              onClick={(): void => choose(d)}
            >
              {d.split(/[\\/]/).filter(Boolean).at(-1) ?? d}
            </button>
          ),
        )}
        {repos !== null && repos.length > 0 && (
          <span className="tree-meta">
            <span>
              {repos.length} {repos.length === 1 ? "repositório" : "repositórios"}
            </span>
            <button
              type="button"
              className="text-button"
              disabled={fetching !== null}
              onClick={(): void => void fetchAll()}
            >
              <RefreshCw className={fetching === null ? "" : "spin"} size={14} strokeWidth={2} aria-hidden />
              {fetching === null ? "Buscar todos do remoto" : `Buscando ${fetching}…`}
            </button>
          </span>
        )}
      </header>
      <div className="tree-scroll">
        {path === null && (
          <p className="tree-empty">
            Escolha uma pasta: um repositório ou uma pasta com vários (como o ambiente inteiro de um produto). O prdesk
            encontra cada repositório lá dentro e desenha as branches, quais têm PR e para onde cada uma vai quando
            mesclar.
          </p>
        )}
        {error !== null && <p className="tree-empty">{error}</p>}
        {path !== null && repos === null && error === null && <p className="tree-empty">Procurando repositórios…</p>}
        {repos !== null && repos.length === 0 && (
          <p className="tree-empty">Nenhum repositório git nesta pasta nem nas subpastas (até 2 níveis).</p>
        )}
        {sorted.map(
          (r): ReactElement => (
            <RepoSection
              key={r.path}
              entry={r}
              prs={prsOf(r.slug)}
              open={sorted.length === 1 || prsOf(r.slug).length > 0}
              version={version}
              onOpenPr={(n): void => {
                if (r.slug !== null) onOpenPr(r.slug, n);
              }}
            />
          ),
        )}
      </div>
    </section>
  );
}
