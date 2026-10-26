import { Bell } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef } from "react";

import { age } from "../lib/format";
import type { Activity } from "../lib/ipc";
import { describe } from "../lib/notify";

export function Feed({
  items,
  seenAt,
  onPick,
  onClose,
}: {
  items: Activity[];
  seenAt: number;
  onPick: (activity: Activity) => void;
  onClose: () => void;
}): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect((): void => {
    dialog.current?.showModal();
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Esc closes the dialog natively
    <dialog
      ref={dialog}
      className="palette feed"
      aria-label="Novidades"
      onClose={onClose}
      onClick={(e): void => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <div className="palette-input">
        <Bell size={18} strokeWidth={2} aria-hidden />
        <span className="feed-heading">Novidades</span>
        <kbd>Esc</kbd>
      </div>
      <ul className="palette-list">
        {items.length === 0 && <li className="palette-empty">Nada nas últimas 24h</li>}
        {items.map((a): ReactElement => {
          const text = describe(a);
          const [where = "", excerpt = ""] = text.body.split("\n");
          const unread = Date.parse(a.updatedAt) > seenAt;
          return (
            <li key={a.id}>
              <button
                type="button"
                className={`feed-item feed-${a.reason}${unread ? " is-unread" : ""}`}
                onClick={(): void => onPick(a)}
              >
                <span className="row-dot" aria-hidden />
                <span className="feed-body">
                  <span className="feed-title">{text.title}</span>
                  <span className="feed-where">{where}</span>
                  {excerpt !== "" && <span className="feed-excerpt">{excerpt}</span>}
                </span>
                <span className="palette-age">{age(a.updatedAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </dialog>
  );
}
