import { createContext, useContext, type ReactNode } from "react";

// Lower-cased needle used to mark matched substrings in PartView and rich
// views. Empty string means "no active search". Set via SessionViewer from
// useMessageSearch().activeHighlight.
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

/**
 * Splits `text` on case-insensitive matches of the active needle and wraps
 * matched ranges in <mark className="search-hit">. Falls back to a plain text
 * node when no needle is active or the text has no match.
 */
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
