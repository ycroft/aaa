import { useCallback, useRef, useState, type RefObject } from "react";
import type { MessagePart, SessionNode } from "../../../types";

// Concat every text-bearing part on a node so the user can match on tool
// arguments / paths / chat text alike.
function nodeHaystack(node: SessionNode): string {
  const buf: string[] = [];
  for (const p of node.parts as MessagePart[]) {
    switch (p.kind) {
      case "text":
      case "thinking":
      case "note":
        if (p.text) buf.push(p.text);
        break;
      case "tool_use":
        buf.push(p.name);
        buf.push(p.input);
        break;
      case "tool_result":
        buf.push(p.content);
        break;
      case "attachment":
        buf.push(p.path);
        if (p.mime) buf.push(p.mime);
        break;
      case "image":
        buf.push(p.media_type);
        break;
    }
  }
  return buf.join("\n");
}

/**
 * In-session message search.
 *
 * Triggered explicitly via the button / Enter, never on each keystroke (some
 * sessions have thousands of nodes). On a miss the input flashes red until
 * the user edits the term. Repeating the same term cycles past the last hit.
 *
 * Cycles through hits when the same term is searched repeatedly: each call
 * advances past the last hit. On a hit the matched node is force-expanded so
 * the result is actually visible.
 */
export function useMessageSearch(
  visibleNodes: SessionNode[],
  bodyRef: RefObject<HTMLDivElement | null>,
  forceExpand: (nodeId: string) => void,
) {
  const [messageSearch, setMessageSearch] = useState("");
  const [searchMissed, setSearchMissed] = useState(false);
  // The needle that's actively driving in-timeline highlights. Set after a
  // successful run() and cleared on reset / empty input. Lower-cased so the
  // <Highlight> component can do raw indexOf without re-normalising.
  const [activeHighlight, setActiveHighlight] = useState("");
  const lastSearchHitRef = useRef<{ term: string; nodeId: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const reset = useCallback(() => {
    setMessageSearch("");
    setSearchMissed(false);
    setActiveHighlight("");
    lastSearchHitRef.current = null;
  }, []);

  const onChange = useCallback((value: string) => {
    setMessageSearch(value);
    setSearchMissed((prev) => (prev ? false : prev));
    if (value.trim() === "") setActiveHighlight("");
  }, []);

  const run = useCallback(() => {
    const term = messageSearch.trim();
    if (!term || visibleNodes.length === 0 || !bodyRef.current) return;
    const needle = term.toLowerCase();
    const last = lastSearchHitRef.current;
    let startIdx = 0;
    if (last && last.term === needle) {
      const lastPos = visibleNodes.findIndex((n) => n.id === last.nodeId);
      if (lastPos >= 0) startIdx = lastPos + 1;
    }
    const total = visibleNodes.length;
    let foundIdx = -1;
    for (let i = 0; i < total; i++) {
      const idx = (startIdx + i) % total;
      const n = visibleNodes[idx];
      if (nodeHaystack(n).toLowerCase().includes(needle)) {
        foundIdx = idx;
        break;
      }
    }
    if (foundIdx < 0) {
      setSearchMissed(true);
      setActiveHighlight("");
      lastSearchHitRef.current = null;
      return;
    }
    setSearchMissed(false);
    setActiveHighlight(needle);
    const target = visibleNodes[foundIdx];
    lastSearchHitRef.current = { term: needle, nodeId: target.id };
    forceExpand(target.id);
    requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      const el = body.querySelector<HTMLElement>(`#node-${CSS.escape(target.id)}`);
      if (!el) return;
      const bodyTop = body.getBoundingClientRect().top;
      const elTop = el.getBoundingClientRect().top;
      body.scrollBy({ top: elTop - bodyTop - 8, behavior: "smooth" });
    });
  }, [messageSearch, visibleNodes, bodyRef, forceExpand]);

  return {
    messageSearch,
    searchMissed,
    activeHighlight,
    inputRef,
    onChange,
    run,
    reset,
  };
}
