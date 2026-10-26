import { GripVertical, Hourglass, Info, Lock, PanelLeftClose } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { type Deps, shortRef } from "../lib/deps";
import { age } from "../lib/format";
import { DEFAULT_LAYOUT, gridTemplate, type LaneLayout, moveLane, normalizeLayout, resizePair } from "../lib/lanes";
import { COLUMN_HINT, COLUMN_LABEL, COLUMNS, type Column, type PullRequest, type TriagedPull } from "../lib/model";
import { loadValue, saveValue } from "../lib/persist";

const EMPTY: Record<Column, string> = {
  myTurn: "Tudo em dia. Nada esperando por você.",
  reviewRequested: "Ninguém pediu seu review.",
  waiting: "Nada aguardando outras pessoas.",
  others: "Nenhuma outra PR nos escopos.",
};

const DRAG_TYPE = "application/x-prdesk-lane";
const isLane = (c: string): c is Column => (COLUMNS as readonly string[]).includes(c);

/** Repo names that exist under more than one org. */
function repoNameClashes(repos: string[]): Set<string> {
  const orgs = new Map<string, Set<string>>();
  for (const full of repos) {
    const [org = "", name = ""] = full.split("/");
    orgs.set(name, (orgs.get(name) ?? new Set()).add(org));
  }
  return new Set([...orgs].filter(([, o]): boolean => o.size > 1).map(([name]): string => name));
}

const sameStory = (a: TriagedPull | undefined, b: TriagedPull): boolean =>
  a !== undefined && a.triage.actor === b.triage.actor && a.triage.reason === b.triage.reason;

const SKELETON_KEYS = ["s1", "s2", "s3", "s4"];

/** CSS idents can't hold the base64 characters GitHub uses in node ids. */
export function transitionName(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function Flags({ item }: { item: TriagedPull }): ReactElement | null {
  const { pr } = item;
  const flags: { text: string; tone: string }[] = [];
  if (pr.branch === "conflicts") flags.push({ text: "Conflitos", tone: "warn" });
  if (pr.branch === "behind") flags.push({ text: "Desatualizada", tone: "dim" });
  if (pr.ciState === "FAILURE" || pr.ciState === "ERROR") flags.push({ text: "CI falhou", tone: "bad" });
  if (pr.isDraft) flags.push({ text: "Rascunho", tone: "dim" });
  if (pr.reviewDecision === "APPROVED") flags.push({ text: "Aprovada", tone: "good" });
  if (flags.length === 0) return null;
  return (
    <span className="flags">
      {flags.map(
        (f): ReactElement => (
          <span key={f.text} className={`flag flag-${f.tone}`}>
            {f.text}
          </span>
        ),
      )}
    </span>
  );
}

// Amber "espera" reads as wait (traffic light); blue "trava" marks a keystone others hang on. Never purple: on
// GitHub purple means merged.
type Role = "waits" | "blocks";

interface Link {
  pr: PullRequest;
  /** What the linked PR is to this row: the one it waits on ("blocks") or one waiting on it ("waits"). */
  role: Role;
}

const open = (links: Deps["blockedBy"]): PullRequest[] =>
  links.flatMap((l): PullRequest[] => (l.pr === null ? [] : [l.pr]));

/** "espera core#643", "trava 2 PRs": the whole dependency story of a card in one short phrase. */
const DEP_LIST_WIDTH = 360;

function DepChip({
  verb,
  kind,
  prs,
  onSelect,
  onLinkHover,
}: {
  verb: string;
  kind: Role;
  prs: PullRequest[];
  onSelect: (id: string) => void;
  onLinkHover: (links: Link[]) => void;
}): ReactElement {
  // Where the list opens, in viewport coordinates; null when closed.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLSpanElement>(null);
  const links = prs.map((pr): Link => ({ pr, role: kind }));
  const first = prs[0];
  const label = prs.length === 1 && first !== undefined ? shortRef(first) : `${prs.length} PRs`;

  // The list lives on <body> so the lane's scroll box cannot clip it; it closes on outside click, Escape or scroll.
  useEffect((): (() => void) | undefined => {
    if (at === null) return undefined;
    const close = (): void => setAt(null);
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (!root.current?.contains(target) && !list.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return (): void => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [at]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only lights the linked cards; the button holds the action
    <span
      ref={root}
      className={`dep-chip role-${kind}`}
      onMouseEnter={(): void => onLinkHover(links)}
      onMouseLeave={(): void => onLinkHover([])}
    >
      <button
        type="button"
        aria-expanded={at !== null}
        onClick={(e): void => {
          if (at !== null) {
            setAt(null);
            return;
          }
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - DEP_LIST_WIDTH - 8)) });
        }}
        onFocus={(): void => onLinkHover(links)}
        onBlur={(): void => onLinkHover([])}
      >
        {kind === "blocks" ? (
          <Hourglass size={12} strokeWidth={2} aria-hidden />
        ) : (
          <Lock size={12} strokeWidth={2} aria-hidden />
        )}
        {verb} {label}
      </button>
      {at !== null &&
        createPortal(
          <span
            ref={list}
            className={`dep-list role-${kind}`}
            role="menu"
            style={{ top: at.top, left: at.left, width: DEP_LIST_WIDTH }}
            onMouseLeave={(): void => onLinkHover([])}
          >
            {prs.map(
              (pr): ReactElement => (
                <button
                  type="button"
                  role="menuitem"
                  key={pr.id}
                  onClick={(): void => {
                    setAt(null);
                    onSelect(pr.id);
                  }}
                  onMouseEnter={(): void => onLinkHover([{ pr, role: kind }])}
                >
                  <span className="dep-list-ref">{shortRef(pr)}</span>
                  <span className="dep-list-title">{pr.title}</span>
                </button>
              ),
            )}
          </span>,
          document.body,
        )}
    </span>
  );
}

function Row({
  item,
  deps,
  linked,
  showOrg,
  repeat,
  onLinkHover,
  rail,
  selected,
  onSelect,
}: {
  item: TriagedPull;
  deps: Deps | undefined;
  /** Lit while a linked PR is hovered: its role in that dependency. */
  linked: Role | undefined;
  /** Another org has a repo with this name, so the owner tells them apart. */
  showOrg: boolean;
  /** Same "who did what" as the card above: dimmed so the different ones stand out. */
  repeat: boolean;
  rail: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  onLinkHover: (links: Link[]) => void;
}): ReactElement {
  const { pr, triage } = item;
  const waitsOn = rail ? [] : open(deps?.blockedBy ?? []);
  const blocks = rail ? [] : open(deps?.blocks ?? []);
  const repoName = showOrg && !rail ? pr.repo : (pr.repo.split("/")[1] ?? pr.repo);
  return (
    <li style={{ viewTransitionName: transitionName("pr", pr.id) }}>
      <button
        type="button"
        className={`row row-${triage.column}${linked === undefined ? "" : ` is-linked role-${linked}`}`}
        aria-current={selected}
        onClick={(): void => onSelect(pr.id)}
      >
        <span className="row-top">
          <span className="row-repo" title={pr.repo}>
            {repoName}
          </span>
          <span className="row-num">#{pr.number}</span>
          <span className="row-age">{age(triage.at)}</span>
        </span>
        <span className="row-title" style={rail ? undefined : { viewTransitionName: transitionName("title", pr.id) }}>
          {pr.title}
        </span>
        {!rail && (
          <span className="row-meta">
            <span className={repeat ? "row-reason is-repeat" : "row-reason"}>
              {triage.actor !== null && <b>{triage.actor} </b>}
              {triage.reason}
            </span>
            <Flags item={item} />
          </span>
        )}
      </button>
      {(waitsOn.length > 0 || blocks.length > 0) && (
        <span className="row-deps">
          {waitsOn.length > 0 && (
            <DepChip verb="espera" kind="blocks" prs={waitsOn} onSelect={onSelect} onLinkHover={onLinkHover} />
          )}
          {blocks.length > 0 && (
            <DepChip verb="trava" kind="waits" prs={blocks} onSelect={onSelect} onLinkHover={onLinkHover} />
          )}
        </span>
      )}
    </li>
  );
}

function LaneHead({
  column,
  count,
  controls,
}: {
  column: Column;
  count: number;
  /** Fold and reorder controls; absent in the rail. */
  controls?: { onCollapse: () => void; onMove: (delta: number) => void };
}): ReactElement {
  return (
    <h2 className="lane-head">
      {controls !== undefined && (
        <button
          type="button"
          className="lane-grip"
          aria-label={`Mover ${COLUMN_LABEL[column]} (setas ← →, ou arraste)`}
          title="Arraste para reordenar"
          onKeyDown={(e): void => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              controls.onMove(e.key === "ArrowLeft" ? -1 : 1);
            }
          }}
        >
          <GripVertical size={13} strokeWidth={2} aria-hidden />
        </button>
      )}
      <span>{COLUMN_LABEL[column]}</span>
      <span className="lane-count">{count}</span>
      <span className="lane-hint">
        <button
          type="button"
          className="lane-info"
          aria-describedby={`hint-${column}`}
          aria-label={`O que é ${COLUMN_LABEL[column]}`}
        >
          <Info size={13} strokeWidth={2} aria-hidden />
        </button>
        <span role="tooltip" id={`hint-${column}`} className="lane-tip">
          {COLUMN_HINT[column]}
        </span>
      </span>
      {controls !== undefined && (
        <button
          type="button"
          className="lane-info"
          aria-label={`Recolher ${COLUMN_LABEL[column]}`}
          title="Recolher coluna"
          onClick={controls.onCollapse}
        >
          <PanelLeftClose size={14} strokeWidth={2} aria-hidden />
        </button>
      )}
    </h2>
  );
}

const PEEK_ITEMS = 5;

/** A folded column: a thin strip that expands on click and previews its PRs on hover. */
function LaneStrip({
  column,
  items,
  peekLeft,
  onExpand,
  onSelect,
}: {
  column: Column;
  items: TriagedPull[];
  /** The strip sits at the right edge, so the preview opens towards the board. */
  peekLeft: boolean;
  onExpand: () => void;
  onSelect: (id: string) => void;
}): ReactElement {
  return (
    <div className={`lane lane-${column} is-collapsed`}>
      <button type="button" className="lane-strip" onClick={onExpand} aria-label={`Expandir ${COLUMN_LABEL[column]}`}>
        <span className="lane-strip-dot" aria-hidden />
        <span className="lane-count">{items.length}</span>
        <span className="lane-strip-label">{COLUMN_LABEL[column]}</span>
      </button>
      <section
        className={peekLeft ? "lane-peek peek-left" : "lane-peek"}
        aria-label={`Prévia de ${COLUMN_LABEL[column]}`}
      >
        <p className="lane-peek-head">
          {COLUMN_LABEL[column]} · {items.length}
        </p>
        {items.length === 0 && <p className="lane-peek-empty">{EMPTY[column]}</p>}
        {items.slice(0, PEEK_ITEMS).map(
          ({ pr, triage }): ReactElement => (
            <button type="button" key={pr.id} className="lane-peek-item" onClick={(): void => onSelect(pr.id)}>
              <span className="lane-peek-ref">
                {pr.repo.split("/")[1] ?? pr.repo} #{pr.number}
              </span>
              <span className="lane-peek-title">{pr.title}</span>
              <span className="lane-peek-reason">
                {triage.actor !== null && <b>{triage.actor} </b>}
                {triage.reason}
              </span>
            </button>
          ),
        )}
        {items.length > PEEK_ITEMS && (
          <button type="button" className="lane-peek-more" onClick={onExpand}>
            +{items.length - PEEK_ITEMS} · expandir coluna
          </button>
        )}
      </section>
    </div>
  );
}

const KEY_STEP_PX = 40;
const LAYOUT_KEY = "laneLayout";

/** The border between two lanes: drag to resize, double-click to even them out, arrows from the keyboard. */
function ResizeHandle({
  enabled,
  onResize,
  onCommit,
  onReset,
}: {
  enabled: boolean;
  /** Pixels moved since the drag started, with the neighbours' widths at that moment. */
  onResize: (dx: number, start: { left: number; right: number }) => void;
  onCommit: () => void;
  onReset: () => void;
}): ReactElement {
  if (!enabled) return <div className="lane-gutter" aria-hidden />;
  const widths = (el: HTMLElement): { left: number; right: number } => ({
    left: el.previousElementSibling?.getBoundingClientRect().width ?? 0,
    right: el.nextElementSibling?.getBoundingClientRect().width ?? 0,
  });
  return (
    // biome-ignore lint/a11y/useSemanticElements: a vertical splitter has no native element; role=separator is the ARIA pattern
    <div
      className="lane-gutter lane-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Redimensionar colunas"
      aria-valuenow={0}
      tabIndex={0}
      title="Arraste para redimensionar · dois cliques para igualar"
      onDoubleClick={onReset}
      onKeyDown={(e): void => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        onResize(e.key === "ArrowLeft" ? -KEY_STEP_PX : KEY_STEP_PX, widths(e.currentTarget));
        onCommit();
      }}
      onPointerDown={(e): void => {
        const el = e.currentTarget;
        const startX = e.clientX;
        const start = widths(el);
        el.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent): void => onResize(ev.clientX - startX, start);
        const up = (): void => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          onCommit();
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
    />
  );
}

export function Board({
  groups,
  deps,
  loading,
  selectedId,
  rail,
  onSelect,
}: {
  groups: Record<Column, TriagedPull[]>;
  deps: Map<string, Deps>;
  loading: boolean;
  selectedId: string | null;
  rail: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  // "Outras" asks nothing of me, so it stays folded until I want it.
  const [showOthers, setShowOthers] = useState(false);
  // Rows lit by hovering a dependency elsewhere on the board.
  const [lit, setLit] = useState<Map<string, Role>>(new Map());
  const [layout, setLayout] = useState<LaneLayout>(DEFAULT_LAYOUT);
  // Column being dragged by its header, and the slot it hovers.
  const [dragging, setDragging] = useState<Column | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const grabbedHead = useRef(false);
  // The org only shows when two orgs have a repo with the same name; otherwise it is noise on every card.
  const ambiguous = repoNameClashes(COLUMNS.flatMap((c): string[] => groups[c].map((t): string => t.pr.repo)));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect((): void => {
    loadValue<unknown>(LAYOUT_KEY, null)
      .then((v): void => setLayout(normalizeLayout(v)))
      .catch((): void => {
        // Degraded: no store (plain browser); the default layout stays.
      });
  }, []);

  const save = (next: LaneLayout): void => {
    setLayout(next);
    saveValue(LAYOUT_KEY, next).catch((): void => {
      // Degraded: the layout still applies for this session.
    });
  };
  const toggle = (c: Column): void =>
    save({ ...layout, collapsed: { ...layout.collapsed, [c]: !layout.collapsed[c] } });

  const lane = (column: Column, index: number): ReactElement | null => {
    const items = groups[column];
    if (rail && items.length === 0) return null;
    if (!rail && layout.collapsed[column]) {
      return (
        <LaneStrip
          key={column}
          column={column}
          items={items}
          peekLeft={index === layout.order.length - 1}
          onExpand={(): void => toggle(column)}
          onSelect={onSelect}
        />
      );
    }
    const folded = !rail && column === "others" && !showOthers && items.length > 0;
    return (
      <div className={`lane lane-${column}`} key={column}>
        <LaneHead
          column={column}
          count={items.length}
          {...(rail
            ? {}
            : {
                controls: {
                  onCollapse: (): void => toggle(column),
                  onMove: (delta: number): void =>
                    save({ ...layout, order: moveLane(layout.order, column, index + delta) }),
                },
              })}
        />
        {folded ? (
          <button type="button" className="lane-reveal" onClick={(): void => setShowOthers(true)}>
            Mostrar {items.length} {items.length === 1 ? "PR" : "PRs"} sem pendência sua
          </button>
        ) : (
          <ul className="lane-rows" aria-label={COLUMN_LABEL[column]}>
            {loading && SKELETON_KEYS.map((k): ReactElement => <li key={k} className="skeleton" aria-hidden />)}
            {!loading && items.length === 0 && <li className="lane-empty">{EMPTY[column]}</li>}
            {items.map(
              (item, i): ReactElement => (
                <Row
                  key={item.pr.id}
                  item={item}
                  deps={deps.get(item.pr.id)}
                  linked={lit.get(item.pr.id)}
                  showOrg={ambiguous.has(item.pr.repo.split("/")[1] ?? "")}
                  repeat={i > 0 && sameStory(items[i - 1], item)}
                  onLinkHover={(links): void => setLit(new Map(links.map((l): [string, Role] => [l.pr.id, l.role])))}
                  rail={rail}
                  selected={item.pr.id === selectedId}
                  onSelect={onSelect}
                />
              ),
            )}
          </ul>
        )}
        {!rail && column === "others" && showOthers && (
          <button type="button" className="lane-reveal" onClick={(): void => setShowOthers(false)}>
            Recolher
          </button>
        )}
      </div>
    );
  };

  if (rail) {
    return (
      <section className="board rail" aria-label="PRs por status">
        <div className="lanes">{layout.order.map(lane)}</div>
      </section>
    );
  }

  return (
    <section className="board" aria-label="PRs por status">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop target for header drags; the grip button covers the keyboard */}
      <div
        className="lanes"
        style={{ gridTemplateColumns: gridTemplate(layout) }}
        onDragOver={(e): void => {
          if (e.dataTransfer.types.includes(DRAG_TYPE)) e.preventDefault();
        }}
        onDrop={(e): void => {
          const column = e.dataTransfer.getData(DRAG_TYPE);
          const target = (e.target as HTMLElement).closest<HTMLElement>("[data-lane]");
          // Dropped on a gutter: the last slot the pointer was over still counts.
          const to = target === null ? over : Number(target.dataset.lane);
          setDragging(null);
          setOver(null);
          if (!isLane(column) || to === null) return;
          e.preventDefault();
          save({ ...layout, order: moveLane(layout.order, column, to) });
        }}
      >
        {layout.order.map((column, i): ReactElement[] => {
          const next = layout.order[i + 1];
          const parts = [
            // biome-ignore lint/a11y/noStaticElementInteractions: drag-to-reorder is a mouse shortcut; the grip button moves lanes from the keyboard
            <div
              key={column}
              className={[
                "lane-slot",
                dragging === column ? "is-dragging" : "",
                dragging !== null && dragging !== column && over === i ? "is-drop" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-lane={i}
              draggable
              onPointerDown={(e): void => {
                // dragstart's target is the dragged slot itself, so where the press began decides instead.
                grabbedHead.current = (e.target as HTMLElement).closest(".lane-head, .lane-strip") !== null;
              }}
              onDragStart={(e): void => {
                // Only the header starts a reorder; row clicks and text selection stay normal.
                if (!grabbedHead.current) {
                  e.preventDefault();
                  return;
                }
                e.dataTransfer.setData(DRAG_TYPE, column);
                e.dataTransfer.effectAllowed = "move";
                setDragging(column);
              }}
              onDragEnter={(): void => setOver(i)}
              onDragEnd={(): void => {
                setDragging(null);
                setOver(null);
              }}
            >
              {lane(column, i)}
            </div>,
          ];
          if (next !== undefined) {
            parts.push(
              <ResizeHandle
                key={`${column}|${next}`}
                enabled={!layout.collapsed[column] && !layout.collapsed[next]}
                onResize={(dx, start): void =>
                  setLayout({
                    ...layoutRef.current,
                    weights: resizePair(layout.weights, column, next, start.left, start.right, dx),
                  })
                }
                onCommit={(): void => save(layoutRef.current)}
                onReset={(): void => save({ ...layout, weights: { ...layout.weights, [column]: 1, [next]: 1 } })}
              />,
            );
          }
          return parts;
        })}
      </div>
    </section>
  );
}
