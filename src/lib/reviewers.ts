import type { PullRequest } from "./model";

/** How many people "Pedir review" asks: enough for a second pair of eyes without spamming the team. */
const ASK = 2;

/**
 * Who usually reviews in a repo, read from the PRs on the board: everyone who reviewed or was asked to, most frequent
 * first. Bots and `me` are left out; each PR counts a person once.
 */
export function usualReviewers(pulls: PullRequest[], repo: string, me: string, limit = ASK): string[] {
  const counts = new Map<string, number>();
  for (const pr of pulls) {
    if (pr.repo !== repo) continue;
    const people = new Set([
      ...pr.reviews.filter((r): boolean => r.isBot !== true).map((r): string => r.author),
      ...pr.requestedReviewers,
    ]);
    people.delete(me);
    if (pr.author !== null) people.delete(pr.author);
    for (const login of people) counts.set(login, (counts.get(login) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b): number => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([login]): string => login);
}

/** My PR nobody was asked to review yet: a draft, or open with no review and no request. */
export function needsReviewers(pr: PullRequest): boolean {
  return pr.isDraft || (pr.requestedReviewers.length === 0 && pr.reviews.every((r): boolean => r.isBot === true));
}
