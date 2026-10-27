import { Check, ChevronDown, ListFilter } from "lucide-react";
import type { ReactElement } from "react";
import { useRef } from "react";

import { pickOrg, toggleRepo } from "../lib/repoFilter";

const shortName = (full: string): string => full.split("/")[1] ?? full;

/**
 * One button that narrows the board to some repos; the list opens as a native popover (outside click and Esc
 * close it) and stays open while picking several. An empty filter shows every repo.
 */
export function RepoFilter({
  orgs,
  filter,
  onChange,
}: {
  orgs: [string, string[]][];
  filter: string[];
  onChange: (next: string[]) => void;
}): ReactElement {
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [first] = filter;
  const label =
    first === undefined ? "Todos os repos" : `${shortName(first)}${filter.length > 1 ? ` +${filter.length - 1}` : ""}`;

  // Anchors the popover under the button's right edge; it renders in the top layer, outside the page flow.
  const place = (): void => {
    const at = trigger.current?.getBoundingClientRect();
    if (at === undefined || list.current === null) return;
    list.current.style.top = `${at.bottom + 6}px`;
    list.current.style.right = `${window.innerWidth - at.right}px`;
  };

  let index = 0;
  return (
    <div className="repo-filter">
      <button
        ref={trigger}
        type="button"
        className="repo-trigger"
        aria-pressed={filter.length > 0}
        title={filter.length === 0 ? "Filtrar por repositório (1–9)" : filter.join(", ")}
        popoverTarget="repo-filter-list"
        onClick={place}
      >
        <ListFilter size={14} strokeWidth={2} aria-hidden /> {label}{" "}
        <ChevronDown size={14} strokeWidth={2} aria-hidden />
      </button>
      <div
        ref={list}
        id="repo-filter-list"
        popover="auto"
        role="dialog"
        className="repo-pop"
        aria-label="Filtrar por repositório"
      >
        <button
          type="button"
          className="repo-option"
          aria-pressed={filter.length === 0}
          onClick={(): void => onChange([])}
        >
          <Check size={14} strokeWidth={2.5} aria-hidden className="repo-check" />
          Todos os repos <kbd>0</kbd>
        </button>
        {orgs.map(
          ([org, repos]): ReactElement => (
            <div key={org} className="repo-pop-group">
              <button
                type="button"
                className="repo-org"
                title={`Mostrar só ${org}`}
                onClick={(): void => onChange(pickOrg(filter, repos))}
              >
                {org}
              </button>
              {repos.map((repo): ReactElement => {
                index += 1;
                return (
                  <button
                    key={repo}
                    type="button"
                    className="repo-option"
                    aria-pressed={filter.includes(repo)}
                    onClick={(): void => onChange(toggleRepo(filter, repo))}
                  >
                    <Check size={14} strokeWidth={2.5} aria-hidden className="repo-check" />
                    {shortName(repo)}
                    {index <= 9 && <kbd>{index}</kbd>}
                  </button>
                );
              })}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
