import { COLUMNS, type Column } from "./model";

/** How the board's columns are arranged: order, relative widths and which ones are folded to a strip. */
export interface LaneLayout {
  order: Column[];
  /** Flex weights (fr) of the expanded columns. */
  weights: Record<Column, number>;
  collapsed: Record<Column, boolean>;
}

export const MIN_LANE_PX = 220;
export const COLLAPSED_PX = 44;
export const GUTTER_PX = 28;
const MIN_WEIGHT = 0.2;
const MAX_WEIGHT = 5;

export const DEFAULT_LAYOUT: LaneLayout = {
  order: [...COLUMNS],
  weights: { myTurn: 1, reviewRequested: 1, waiting: 1, others: 1 },
  collapsed: { myTurn: false, reviewRequested: false, waiting: false, others: false },
};

const isColumn = (c: unknown): c is Column => typeof c === "string" && (COLUMNS as readonly string[]).includes(c);

/** The stored value comes from a settings file: keep what is valid, default the rest. */
export function normalizeLayout(raw: unknown): LaneLayout {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof LaneLayout, unknown>>;
  const saved = Array.isArray(r.order) ? r.order.filter(isColumn) : [];
  const order = [...new Set([...saved, ...COLUMNS])];
  const weights = { ...DEFAULT_LAYOUT.weights };
  const collapsed = { ...DEFAULT_LAYOUT.collapsed };
  for (const c of COLUMNS) {
    const w = (r.weights as Record<string, unknown> | undefined)?.[c];
    if (typeof w === "number" && Number.isFinite(w)) weights[c] = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, w));
    collapsed[c] = (r.collapsed as Record<string, unknown> | undefined)?.[c] === true;
  }
  return { order, weights, collapsed };
}

/** CSS grid tracks: each lane, with a gutter track between lanes for the resize handle. */
export function gridTemplate(layout: LaneLayout): string {
  return layout.order
    .map((c): string =>
      layout.collapsed[c] ? `${COLLAPSED_PX}px` : `minmax(${MIN_LANE_PX}px, ${layout.weights[c]}fr)`,
    )
    .join(` ${GUTTER_PX}px `);
}

/** Moves a column to another position in the order. */
export function moveLane(order: Column[], column: Column, to: number): Column[] {
  const rest = order.filter((c): boolean => c !== column);
  const at = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, at), column, ...rest.slice(at)];
}

/**
 * Drags the border between two expanded neighbours by `dx` pixels: one grows as much as the other shrinks,
 * neither below MIN_LANE_PX. Widths are the rendered pixel widths at drag start.
 */
export function resizePair(
  weights: Record<Column, number>,
  left: Column,
  right: Column,
  leftPx: number,
  rightPx: number,
  dx: number,
): Record<Column, number> {
  const total = leftPx + rightPx;
  const nextLeft = Math.max(MIN_LANE_PX, Math.min(total - MIN_LANE_PX, leftPx + dx));
  const sum = weights[left] + weights[right];
  return { ...weights, [left]: (sum * nextLeft) / total, [right]: (sum * (total - nextLeft)) / total };
}
