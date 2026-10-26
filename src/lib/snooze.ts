import type { PullRequest } from "./model";

/** A PR hidden from the board until `until` (null: no deadline) or until it gets new activity. */
export interface Snooze {
  until: number | null;
  /** `updatedAt` when snoozed: any later activity wakes it up. */
  updatedAt: string;
}

export type Snoozes = Record<string, Snooze>;

const WAKE_HOUR = 9;
const MONDAY = 1;

function at9(day: Date): number {
  const d = new Date(day);
  d.setHours(WAKE_HOUR, 0, 0, 0);
  return d.getTime();
}

/** Tomorrow 9h, next Monday 9h, or no deadline ("until it changes"). */
export function wakeTime(choice: "tomorrow" | "monday" | "change", now: Date): number | null {
  if (choice === "change") return null;
  const day = new Date(now);
  if (choice === "tomorrow") {
    day.setDate(day.getDate() + 1);
  } else {
    const ahead = (MONDAY - day.getDay() + 7) % 7 || 7;
    day.setDate(day.getDate() + ahead);
  }
  return at9(day);
}

export function isSnoozed(snooze: Snooze | undefined, pr: PullRequest, now: number): boolean {
  if (snooze === undefined || pr.updatedAt !== snooze.updatedAt) return false;
  return snooze.until === null || now < snooze.until;
}
