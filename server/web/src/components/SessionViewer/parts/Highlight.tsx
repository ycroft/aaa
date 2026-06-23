import { createContext, useContext, type ReactNode } from "react";

const SearchHighlightContext = createContext<string>("");

export function SearchHighlightProvider({
  needle,
  children,
}: {
  needle: string;
  children: ReactNode;
}) {
  return (
    <SearchHighlightContext.Provider value={needle}>
      {children}
    </SearchHighlightContext.Provider>
  );
}

export function useSearchHighlight(): string {
  return useContext(SearchHighlightContext);
}

export function Highlight({ text }: { text: string }) {
  const needle = useSearchHighlight();
  if (!text) return <>{text}</>;
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const len = needle.length;
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const hit = lower.indexOf(needle, i);
    if (hit < 0) {
      out.push(text.slice(i));
      break;
    }
    if (hit > i) out.push(text.slice(i, hit));
    out.push(
      <mark key={key++} className="search-hit">
        {text.slice(hit, hit + len)}
      </mark>,
    );
    i = hit + len;
  }
  return <>{out}</>;
}
