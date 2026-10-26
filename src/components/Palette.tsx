import { Search } from "lucide-react";
import type { KeyboardEvent, ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { age } from "../lib/format";
import { COLUMN_LABEL, type TriagedPull } from "../lib/model";

const MAX_RESULTS = 12;

/** Every query word must appear in "repo #number title", case-insensitively. */
export function matches(item: TriagedPull, query: string): boolean {
  const haystack = `${item.pr.repo} #${item.pr.number} ${item.pr.title}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word): boolean => haystack.includes(word));
}

export function Palette({
  items,
  onPick,
  onClose,
}: {
  items: TriagedPull[];
  onPick: (id: string) => void;
  onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(
    (): TriagedPull[] => items.filter((i): boolean => matches(i, query)).slice(0, MAX_RESULTS),
    [items, query],
  );

  useEffect((): void => {
    dialog.current?.showModal();
  }, []);

  const pick = (item: TriagedPull | undefined): void => {
    if (item !== undefined) onPick(item.pr.id);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a): number => Math.min(results.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a): number => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      pick(results[active]);
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Esc closes the dialog natively
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Buscar PR"
      onClose={onClose}
      onClick={(e): void => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <div className="palette-input">
        <Search size={18} strokeWidth={2} aria-hidden />
        <input
          // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into
          autoFocus
          value={query}
          placeholder="Buscar por repo, número ou título…"
          aria-label="Buscar PR"
          onChange={(e): void => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
        <kbd>Esc</kbd>
      </div>
      <ul className="palette-list">
        {results.length === 0 && <li className="palette-empty">Nenhuma PR encontrada</li>}
        {results.map(
          (item, i): ReactElement => (
            <li key={item.pr.id}>
              <button
                type="button"
                className={`palette-item row-${item.triage.column}`}
                aria-current={i === active}
                onMouseEnter={(): void => setActive(i)}
                onClick={(): void => pick(item)}
              >
                <span className="row-dot" aria-hidden />
                <span className="palette-repo">
                  {item.pr.repo} <b>#{item.pr.number}</b>
                </span>
                <span className="palette-title">{item.pr.title}</span>
                <span className="palette-col">{COLUMN_LABEL[item.triage.column]}</span>
                <span className="palette-age">{age(item.triage.at)}</span>
              </button>
            </li>
          ),
        )}
      </ul>
    </dialog>
  );
}
