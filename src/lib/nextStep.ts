/** What the PR needs from me right now, in the order it should be done. */
export type NextStep =
  | "send-review"
  | "review-files"
  | "conflicts"
  | "autopilot"
  | "merge"
  | "ready"
  | "update-branch"
  | null;

export interface StepInput {
  mine: boolean;
  closed: boolean;
  conflicting: boolean;
  /** Human threads waiting on me plus failing checks. */
  pending: number;
  mergeReady: boolean;
  draft: boolean;
  behind: boolean;
  /** A dependency declared in the description is still open. */
  blocked: boolean;
  /** Line comments sitting in my review draft. */
  drafts: number;
  /** I already approved this one. */
  approved: boolean;
  onFilesTab: boolean;
}

/** One obvious next action per PR; everything else lives in the "Mais" menu. */
export function nextStep(s: StepInput): NextStep {
  if (s.closed) return null;
  if (!s.mine) {
    if (s.drafts > 0) return "send-review";
    return s.approved || s.onFilesTab ? null : "review-files";
  }
  if (s.conflicting) return "conflicts";
  if (s.pending > 0) return "autopilot";
  if (s.mergeReady && !s.blocked) return "merge";
  if (s.draft) return "ready";
  if (s.behind) return "update-branch";
  return null;
}
