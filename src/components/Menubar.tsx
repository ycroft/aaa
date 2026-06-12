import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";

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
  items: Item[];
}

export function Menubar({ menus }: { menus: MenuDef[] }) {
  const t = useT();
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openIdx == null) return;
    const handle = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpenIdx(null);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [openIdx]);

  return (
    <div className="menubar" ref={ref}>
      <div className="brand" data-hint={t("app.brand_hint")}>
        <span className="dot" />
        <span>AAA</span>
      </div>
      {menus.map((m, i) => (
        <div key={m.label} className={`menu${openIdx === i ? " open" : ""}`}>
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              setOpenIdx(openIdx === i ? null : i);
            }}
            onMouseEnter={() => openIdx != null && setOpenIdx(i)}
            data-hint={`${m.label}`}
          >
            {m.label}
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
