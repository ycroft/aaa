import { useEffect, useState } from "react";

export function useStatusHint() {
  const [hint, setHint] = useState<string>("");
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const node = t.closest<HTMLElement>("[data-hint]");
      setHint(node?.dataset.hint ?? "");
    };
    document.addEventListener("mouseover", handle);
    return () => document.removeEventListener("mouseover", handle);
  }, []);
  return hint;
}
