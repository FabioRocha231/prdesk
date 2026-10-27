import type { ReactElement } from "react";

import { repoColor } from "../lib/holders";
import { pickOrg, toggleRepo } from "../lib/repoFilter";

const shortName = (full: string): string => full.split("/")[1] ?? full;

/**
 * The sidebar's repos: each with its colour (the same dot every PR row shows) and how many PRs it has. Picking
 * repos narrows the list; an org's name shows only that org; an empty filter shows every repo. Keys 1–9 and 0 too.
 */
export function RepoFilter({
  orgs,
  filter,
  counts,
  onChange,
}: {
  orgs: [string, string[]][];
  filter: string[];
  counts: ReadonlyMap<string, number>;
  onChange: (next: string[]) => void;
}): ReactElement {
  let index = 0;
  return (
    <nav className="side-repos" aria-label="Filtrar por repositório">
      <div className="side-sec">
        <span>Repositórios</span>
        {filter.length > 0 && (
          <button type="button" className="side-clear" title="Mostrar todos (0)" onClick={(): void => onChange([])}>
            Todos
          </button>
        )}
      </div>
      {orgs.map(
        ([org, repos]): ReactElement => (
          <div key={org} className="side-org">
            {orgs.length > 1 && (
              <button
                type="button"
                className="side-org-name"
                title={`Mostrar só ${org}`}
                onClick={(): void => onChange(pickOrg(filter, repos))}
              >
                {org}
              </button>
            )}
            {repos.map((repo): ReactElement => {
              index += 1;
              return (
                <button
                  key={repo}
                  type="button"
                  className="side-item"
                  aria-pressed={filter.includes(repo)}
                  title={index <= 9 ? `${repo} (${index})` : repo}
                  onClick={(): void => onChange(toggleRepo(filter, repo))}
                >
                  <span className="side-dot" style={{ background: repoColor(repo) }} aria-hidden />
                  <span className="side-label">{shortName(repo)}</span>
                  <b>{counts.get(repo) ?? 0}</b>
                </button>
              );
            })}
          </div>
        ),
      )}
    </nav>
  );
}
