import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

import { dependencyIndex, isBlocked, shortRef } from "./deps";
import type { Activity } from "./ipc";
import type { PullRequest } from "./model";

// Beyond this, one summary notification instead of a burst.
const MAX_INDIVIDUAL = 3;
const MAX_EXCERPT = 200;
const MAX_FEED = 50;

const VERB: Record<string, string> = {
  review_requested: "pediu seu review",
  mention: "mencionou você",
  team_mention: "mencionou seu time",
  comment: "comentou",
  author: "comentou na sua PR",
  assign: "atribuiu a PR a você",
  state_change: "mudou o estado da PR",
};

let permitted: boolean | null = null;

async function canNotify(): Promise<boolean> {
  if (permitted === null) {
    permitted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  }
  return permitted;
}

/** First lines of a markdown body as plain-ish text: no HTML comments (PR templates), collapsed whitespace. */
export function excerpt(markdown: string): string {
  const text = markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[#>*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT - 1)}…` : text;
}

/** Notification text in the GitHub Mobile shape: "@who did what", then "repo #n · title" and an excerpt. */
export function describe(a: Activity): { title: string; body: string } {
  const verb = VERB[a.reason] ?? "atualizou a PR";
  const where = `${a.repo}${a.number === null ? "" : ` #${a.number}`}`;
  const text = a.body === null ? "" : excerpt(a.body);
  return {
    title: a.actor === null ? `${verb[0]?.toUpperCase() ?? ""}${verb.slice(1)}` : `@${a.actor} ${verb}`,
    body: [`${where} · ${a.title}`, text].filter(Boolean).join("\n"),
  };
}

/** Mirrors the my-turn count on the app icon (macOS/Linux) and next to the tray icon (every OS). */
export async function setBadge(myTurn: number): Promise<void> {
  try {
    await invoke("set_tray_count", { count: myTurn });
  } catch {
    // Degraded: no tray (plain browser); the board still shows the count.
  }
  try {
    await getCurrentWindow().setBadgeCount(myTurn > 0 ? myTurn : undefined);
  } catch {
    // Degraded: badges are unsupported on Windows; the tray carries the count there.
  }
}

/** Sends one native notification per new activity, skipping my own actions. */
export async function notifyActivity(items: Activity[], me: string | null): Promise<void> {
  const fresh = items.filter((a): boolean => a.actor === null || a.actor !== me);
  if (fresh.length === 0 || !(await canNotify())) return;
  if (fresh.length > MAX_INDIVIDUAL) {
    sendNotification({ title: `${fresh.length} novidades nas suas PRs`, body: "Abra o prdesk para ver." });
    return;
  }
  for (const a of fresh) sendNotification(describe(a));
}

/** An agent's terminal went quiet: it most likely finished or is asking something. */
export async function notifyAgentQuiet(agentName: string, where: string): Promise<void> {
  if (!(await canNotify())) return;
  sendNotification({
    title: `${agentName} parou`,
    body: [where, "Provavelmente terminou ou está esperando você."].filter(Boolean).join("\n"),
  });
}

/** Newest-first feed: a thread that got new activity moves to the top instead of repeating. */
export function mergeFeed(feed: Activity[], incoming: Activity[]): Activity[] {
  const ids = new Set(incoming.map((a): string => a.id));
  return [...incoming, ...feed.filter((a): boolean => !ids.has(a.id))]
    .sort((a, b): number => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_FEED);
}

export interface Alert {
  title: string;
  body: string;
}

/** What changed on my own PRs between two polls that GitHub never notifies: conflicts, base moved, dependency gone. */
export function branchChanges(before: PullRequest[], after: PullRequest[], me: string): Alert[] {
  const prev = new Map(before.map((p): [string, PullRequest] => [p.id, p]));
  const blockedBefore = dependencyIndex(before);
  const blockedAfter = dependencyIndex(after);
  const alerts: Alert[] = [];
  for (const pr of after) {
    const old = prev.get(pr.id);
    if (pr.author !== me || old === undefined) continue;
    const where = `${shortRef(pr)} · ${pr.title}`;
    if (pr.branch === "conflicts" && old.branch !== "conflicts")
      alerts.push({ title: "Sua PR tem conflitos", body: where });
    else if (pr.branch === "behind" && old.branch === "ok")
      alerts.push({ title: "Sua PR ficou desatualizada", body: where });
    const was = blockedBefore.get(pr.id);
    if (isBlocked(was) && !isBlocked(blockedAfter.get(pr.id))) {
      const gone = (was?.blockedBy ?? [])
        .filter((d): boolean => d.pr !== null)
        .map(shortRef)
        .join(", ");
      alerts.push({ title: "PR liberada para merge", body: `${gone} não está mais aberta\n${where}` });
    }
  }
  return alerts;
}

export async function notifyBranchChanges(before: PullRequest[], after: PullRequest[], me: string): Promise<void> {
  const alerts = branchChanges(before, after, me);
  if (alerts.length === 0 || !(await canNotify())) return;
  for (const a of alerts.slice(0, MAX_INDIVIDUAL)) sendNotification(a);
}
