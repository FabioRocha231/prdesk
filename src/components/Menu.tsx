import { ChevronDown } from "lucide-react";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Items with the same group sit together, separated from the next group by a rule. */
  group: string;
  tone?: "danger";
  disabled?: boolean;
  onSelect: () => void;
}

/** A small dropdown for secondary actions; closes on outside click, Escape and selection. */
export function Menu({ label, items }: { label: string; items: MenuItem[] }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined;
    list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onDown = (e: MouseEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return (): void => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (items.length === 0) return null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Only an open menu takes Esc; a closed one lets it reach the app (back to the board).
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>(".menu-trigger")?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % buttons.length : (at - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only routes arrow keys between its menu items
    <div className="menu" ref={root} onKeyDown={onKey}>
      <button
        type="button"
        className="menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(): void => setOpen(!open)}
      >
        {label} <ChevronDown size={14} strokeWidth={2} aria-hidden />
      </button>
      {open && (
        <div className="menu-list" role="menu" ref={list}>
          {items.map(
            (item, i): ReactElement => (
              <div key={item.key} role="none">
                {i > 0 && items[i - 1]?.group !== item.group && <hr className="menu-rule" />}
                <button
                  type="button"
                  role="menuitem"
                  className={item.tone === "danger" ? "menu-item danger" : "menu-item"}
                  disabled={item.disabled}
                  onClick={(): void => {
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  <span className="menu-icon" aria-hidden>
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
