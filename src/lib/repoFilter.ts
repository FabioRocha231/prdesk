/** Repos on the board grouped by org, both sorted: the order the filter chips (and keys 1-9) follow. */
export function reposByOrg(repos: string[]): [string, string[]][] {
  const orgs = new Map<string, string[]>();
  for (const full of [...new Set(repos)].sort()) {
    const org = full.split("/")[0] ?? "";
    orgs.set(org, [...(orgs.get(org) ?? []), full]);
  }
  return [...orgs];
}

/** The saved filter minus repos that left the board; empty means every repo shows. */
export function activeFilter(filter: string[], repos: string[]): string[] {
  return filter.filter((r): boolean => repos.includes(r));
}

export function toggleRepo(filter: string[], repo: string): string[] {
  return filter.includes(repo) ? filter.filter((r): boolean => r !== repo) : [...filter, repo];
}

/** Picking an org shows only it; picking it again while it alone is shown clears the filter. */
export function pickOrg(filter: string[], orgRepos: string[]): string[] {
  const only = filter.length === orgRepos.length && orgRepos.every((r): boolean => filter.includes(r));
  return only ? [] : orgRepos;
}
