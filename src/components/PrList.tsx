import {
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  Eye,
  FileDiff,
  GitMerge,
  GitPullRequest,
  Link2,
  type LucideIcon,
  MessageSquare,
  RotateCcw,
  TriangleAlert,
  UserPlus,
} from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";

import { age } from "../lib/format";
import { type HolderGroup, holderGroups, repoColor, VERB } from "../lib/holders";
import { COLUMNS, type Column, type PullRequest, type TriagedPull, type TurnKind } from "../lib/model";
import { needsReviewers, usualReviewers } from "../lib/reviewers";
import { STALE_HOURS, workingHours } from "../lib/track";
import { type AskReview, AskReviewButton } from "./Board";

/**
 * Icon and tone per kind. What is mine to do colours its icon and verb; what waits on others keeps a grey verb and
 * only says its state through the icon, the GitHub way: open or approved green, changes asked or a review pending
 * amber, drafts and blocked ones grey.
 */
const KIND: Record<
  TurnKind,
  { icon: LucideIcon; tone: "talk" | "review" | "fix" | "merge" | "wait" | "wait-good" | "wait-warn" }
> = {
  conflicts: { icon: TriangleAlert, tone: "fix" },
  thread: { icon: MessageSquare, tone: "talk" },
  changes: { icon: FileDiff, tone: "fix" },
  ci: { icon: CircleX, tone: "fix" },
  comment: { icon: MessageSquare, tone: "talk" },
  "ask-again": { icon: RotateCcw, tone: "talk" },
  merge: { icon: GitMerge, tone: "merge" },
  "blocked-approved": { icon: Link2, tone: "wait" },
  blocked: { icon: Link2, tone: "wait" },
  draft: { icon: CircleDashed, tone: "wait" },
  "review-wait": { icon: Clock, tone: "wait-warn" },
  "rereview-wait": { icon: Clock, tone: "wait-warn" },
  unrequested: { icon: UserPlus, tone: "wait" },
  reply: { icon: MessageSquare, tone: "talk" },
  "review-requested": { icon: Eye, tone: "review" },
  "review-again": { icon: Eye, tone: "review" },
  approved: { icon: CircleCheck, tone: "wait-good" },
  "changes-requested": { icon: FileDiff, tone: "wait-warn" },
  open: { icon: GitPullRequest, tone: "wait-good" },
};

/** What a PR needs, as the list shows it: the kind's icon and verb, in its tone. */
export function TurnBadge({ kind }: { kind: TurnKind }): ReactElement {
  const { icon: Icon, tone } = KIND[kind];
  return (
    <span className={`turn tone-${tone}`}>
      <Icon className="pl-icon" size={15} strokeWidth={2.2} aria-hidden />
      {VERB[kind]}
    </span>
  );
}

const TITLE: Record<HolderGroup["kind"], (g: HolderGroup) => string> = {
  me: () => "Com você",
  person: (g) => `Com ${g.login}`,
  nobody: () => "Com ninguém",
  team: () => "Do time, sem nada com você",
};

const MAX_FACES = 3;

function Face({ login, url }: { login: string; url: string | undefined }): ReactElement {
  const [broken, setBroken] = useState(false);
  return (
    <span className="pl-face" title={login}>
      {url !== undefined && !broken ? (
        <img src={url} alt="" onError={(): void => setBroken(true)} />
      ) : (
        login.slice(0, 2).toUpperCase()
      )}
    </span>
  );
}

/** Who the row is about: the reviewers it waits on, or whoever acted last. */
function facesOf(item: TriagedPull): string[] {
  const h = item.triage.holder;
  if (h.kind === "people") return h.logins;
  return item.triage.actor === null ? [] : [item.triage.actor];
}

function Row({
  item,
  selected,
  compact,
  now,
  reviewers,
  onSelect,
  onAskReview,
}: {
  item: TriagedPull;
  selected: boolean;
  compact: boolean;
  now: number;
  /** Who to ask when nobody was asked yet; null hides the action. */
  reviewers: string[] | null;
  onSelect: (id: string) => void;
  onAskReview: AskReview | undefined;
}): ReactElement {
  const { pr, triage } = item;
  const { icon: Icon, tone } = KIND[triage.kind];
  const since = triage.at ?? pr.updatedAt;
  const stale = workingHours(Date.parse(since), now) >= STALE_HOURS;
  const why = triage.actor === null ? triage.reason : `${triage.actor} ${triage.reason}`;
  const faces = facesOf(item);
  const row = (
    <button
      type="button"
      className={["pl-row", `tone-${tone}`, stale ? "is-stale" : ""].filter(Boolean).join(" ")}
      aria-current={selected}
      title={compact ? `${VERB[triage.kind]}: ${pr.title} (${pr.repo} #${pr.number})` : undefined}
      onClick={(): void => onSelect(pr.id)}
    >
      <Icon className="pl-icon" size={16} strokeWidth={2.2} aria-hidden />
      {!compact && <span className="pl-verb">{VERB[triage.kind]}</span>}
      <span className="pl-title">
        <span>{pr.title}</span>
        {!compact && why !== "" && <em>{why}</em>}
      </span>
      <span className="pl-repo">
        <span className="pl-dot" style={{ background: repoColor(pr.repo) }} aria-hidden />
        {!compact && <span className="pl-repo-name">{pr.repo.split("/").pop()}</span>}
        <span className="pl-num">#{pr.number}</span>
      </span>
      {!compact && (
        <span className="pl-faces">
          {faces.slice(0, MAX_FACES).map(
            (login): ReactElement => (
              <Face key={login} login={login} url={pr.avatars?.[login]} />
            ),
          )}
        </span>
      )}
      <span className="pl-age" title={stale ? "Parada há mais de um dia útil" : undefined}>
        {age(since, now)}
      </span>
    </button>
  );
  if (reviewers === null || onAskReview === undefined) return row;
  // The action sits beside the row, not inside it: a button cannot hold another button.
  return (
    <div className="pl-line">
      {row}
      <span className="pl-action">
        <AskReviewButton pr={pr} logins={reviewers} onAsk={onAskReview} />
      </span>
    </div>
  );
}

/** The board as one list: a group per whoever holds the ball, a row per PR. `compact` is the rail inside a PR. */
export function PrList({
  groups,
  loading,
  selectedId,
  compact = false,
  onSelect,
  onAskReview,
}: {
  groups: Record<Column, TriagedPull[]>;
  loading: boolean;
  selectedId: string | null;
  compact?: boolean;
  onSelect: (id: string) => void;
  onAskReview?: AskReview;
}): ReactElement {
  const [teamOpen, setTeamOpen] = useState(false);
  const now = Date.now();
  const all = holderGroups(groups);
  const allPulls = COLUMNS.flatMap((c): PullRequest[] => groups[c].map((t): PullRequest => t.pr));
  // My PR that nobody was asked to review: offer the repo's usual reviewers (a draft can also just be readied).
  const reviewersFor = ({ pr, triage }: TriagedPull): string[] | null => {
    if (compact || triage.holder.kind !== "nobody" || !needsReviewers(pr)) return null;
    const logins = usualReviewers(allPulls, pr.repo, pr.author ?? "");
    return logins.length > 0 || pr.isDraft ? logins : null;
  };
  if (loading) return <p className="pl-empty">Carregando as PRs</p>;
  if (all.length === 0) return <p className="pl-empty">Nenhuma PR aberta com você ou com o time.</p>;
  return (
    <div className={compact ? "prlist is-compact" : "prlist"}>
      {all.map((g): ReactElement => {
        const folded = g.kind === "team" && !teamOpen && !g.items.some((i): boolean => i.pr.id === selectedId);
        const title = TITLE[g.kind](g);
        return (
          <section key={g.key} className={`pl-group pl-${g.kind}`} aria-label={title}>
            {g.kind === "team" ? (
              <button
                type="button"
                className="pl-head is-toggle"
                aria-expanded={!folded}
                onClick={(): void => setTeamOpen(folded)}
              >
                <ChevronRight className="pl-chevron" size={15} strokeWidth={2.2} aria-hidden />
                {title} <span>{g.items.length}</span>
              </button>
            ) : (
              <h2 className="pl-head">
                {title} <span>{g.items.length}</span>
              </h2>
            )}
            {!folded &&
              g.items.map(
                (item): ReactElement => (
                  <Row
                    key={item.pr.id}
                    item={item}
                    selected={item.pr.id === selectedId}
                    compact={compact}
                    now={now}
                    reviewers={reviewersFor(item)}
                    onSelect={onSelect}
                    onAskReview={onAskReview}
                  />
                ),
              )}
          </section>
        );
      })}
    </div>
  );
}
