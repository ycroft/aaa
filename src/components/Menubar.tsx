import { useEffect, useMemo, useRef, useState } from "react";

interface Item {
  label: string;
  hint?: string;
  shortcut?: string;
  disabled?: boolean;
  onClick?: () => void;
  separator?: boolean;
}

export interface MenuDef {
  label: string;
  // Single uppercase letter that opens this menu via Alt+<letter>. The same
  // letter is rendered visually as `Label(F)` with the F underlined so the
  // affordance is discoverable without needing to hold Alt to reveal it.
  accelerator?: string;
  items: Item[];
}

export function Menubar({ menus }: { menus: MenuDef[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Index accelerator → menu position once per menus change. Uppercase keys
  // so we match against e.key.toUpperCase() regardless of caps-lock state.
  const accMap = useMemo(() => {
    const m = new Map<string, number>();
    menus.forEach((menu, i) => {
      if (menu.accelerator) m.set(menu.accelerator.toUpperCase(), i);
    });
    return m;
  }, [menus]);

  // Click-outside dismissal — only attached while a menu is open.
  useEffect(() => {
    if (openIdx == null) return;
    const handle = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpenIdx(null);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [openIdx]);

  // Global Alt+<letter> opens the matching menu. Escape closes any open menu.
  // We require pure Alt (no Ctrl/Meta/Shift) so this never collides with
  // existing combos like Ctrl+Alt+F (filter sessions).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openIdx != null) {
        setOpenIdx(null);
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const k = (e.key || "").toUpperCase();
      if (k.length !== 1) return;
      const idx = accMap.get(k);
      if (idx == null) return;
      e.preventDefault();
      setOpenIdx((cur) => (cur === idx ? null : idx));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [accMap, openIdx]);

  return (
    <div className="menubar" ref={ref}>
      {menus.map((m, i) => (
        <div key={m.label} className={`menu${openIdx === i ? " open" : ""}`}>
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              setOpenIdx(openIdx === i ? null : i);
            }}
            onMouseEnter={() => openIdx != null && setOpenIdx(i)}
            data-hint={m.label}
          >
            {m.label}
            {m.accelerator && (
              <>
                (<span className="acc">{m.accelerator.toUpperCase()}</span>)
              </>
            )}
          </button>
          {openIdx === i && (
            <div className="dropdown" onMouseDown={(e) => e.stopPropagation()}>
              {m.items.map((it, j) =>
                it.separator ? (
                  <div className="sep" key={j} />
                ) : (
                  <button
                    key={j}
                    disabled={!!it.disabled}
                    data-hint={it.hint ?? it.label}
                    onClick={() => {
                      setOpenIdx(null);
                      it.onClick?.();
                    }}
                  >
                    <span>{it.label}</span>
                    {it.shortcut && <span className="kbd">{it.shortcut}</span>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
