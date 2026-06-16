import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
        // opencode carries the tool's stdout on `output`; include it so users
        // can search for text the tool printed (file contents, error frames,
        // etc.) just like they did before output got split off `input`.
        if (p.output) buf.push(p.output);
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
 * The search is committed via the magnifier button or Enter, never on each
 * keystroke (some sessions have thousands of nodes). On a miss the input
 * flashes red until the user edits the term.
 *
 * After a successful run the hook exposes the full list of hit indices plus
 * a 0-based cursor; callers can render a slider to scrub forward/backward
 * through hits and a "n/total" counter. Pressing Enter / clicking the
 * magnifier with the same active term still advances to the next hit
 * (cycling at the end), so the existing keyboard flow keeps working.
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
  // 0-based cursor into hitIndices. -1 means "no hit focused yet" — the
  // counter UI hides until run() seeds the cursor.
  const [currentOrdinal, setCurrentOrdinal] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Derived from (visibleNodes, activeHighlight). Rebuilt whenever the
  // filtered node list shifts (tool filter, agent switch) so the slider
  // domain stays in sync without an explicit invalidation step.
  const hitIndices = useMemo(() => {
    if (!activeHighlight) return [] as number[];
    const out: number[] = [];
    for (let i = 0; i < visibleNodes.length; i++) {
      if (nodeHaystack(visibleNodes[i]).toLowerCase().includes(activeHighlight)) {
        out.push(i);
      }
    }
    return out;
  }, [visibleNodes, activeHighlight]);

  // Keep the cursor inside the new hit set when filtering shrinks it. Drop
  // back to -1 when there are no hits at all so the slider/counter hide.
  useEffect(() => {
    setCurrentOrdinal((prev) => {
      if (hitIndices.length === 0) return -1;
      if (prev < 0) return prev;
      if (prev >= hitIndices.length) return hitIndices.length - 1;
      return prev;
    });
  }, [hitIndices.length]);

  const reset = useCallback(() => {
    setMessageSearch("");
    setSearchMissed(false);
    setActiveHighlight("");
    setCurrentOrdinal(-1);
  }, []);

  const onChange = useCallback((value: string) => {
    setMessageSearch(value);
    setSearchMissed((prev) => (prev ? false : prev));
    if (value.trim() === "") {
      setActiveHighlight("");
      setCurrentOrdinal(-1);
    }
  }, []);

  // Reveal + smooth-scroll a hit into view. Used by both run() (advance) and
  // goTo() (slider drag). The target node is force-expanded so the matched
  // text is actually rendered before we measure where to scroll.
  const focusHit = useCallback(
    (nodeIdx: number) => {
      const target = visibleNodes[nodeIdx];
      if (!target) return;
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
    },
    [visibleNodes, bodyRef, forceExpand],
  );

  const run = useCallback(() => {
    const term = messageSearch.trim();
    if (!term || visibleNodes.length === 0 || !bodyRef.current) return;
    const needle = term.toLowerCase();

    // Recompute synchronously so we can decide what to focus without waiting
    // for the memoized hitIndices to refresh on the next render.
    const hits: number[] = [];
    for (let i = 0; i < visibleNodes.length; i++) {
      if (nodeHaystack(visibleNodes[i]).toLowerCase().includes(needle)) {
        hits.push(i);
      }
    }
    if (hits.length === 0) {
      setSearchMissed(true);
      setActiveHighlight("");
      setCurrentOrdinal(-1);
      return;
    }
    setSearchMissed(false);

    // Same term as last commit → advance to next hit (wrap). New term →
    // start at the first hit.
    let nextOrdinal = 0;
    if (needle === activeHighlight && currentOrdinal >= 0) {
      nextOrdinal = (currentOrdinal + 1) % hits.length;
    } else {
      setActiveHighlight(needle);
    }
    setCurrentOrdinal(nextOrdinal);
    focusHit(hits[nextOrdinal]);
  }, [messageSearch, visibleNodes, bodyRef, activeHighlight, currentOrdinal, focusHit]);

  // Slider / programmatic jump. Clamps to a valid ordinal; no-op when there
  // are no hits.
  const goTo = useCallback(
    (ordinal: number) => {
      if (hitIndices.length === 0) return;
      const clamped = Math.max(0, Math.min(hitIndices.length - 1, ordinal));
      setCurrentOrdinal(clamped);
      focusHit(hitIndices[clamped]);
    },
    [hitIndices, focusHit],
  );

  return {
    messageSearch,
    searchMissed,
    activeHighlight,
    inputRef,
    onChange,
    run,
    reset,
    /** Total hits in the current visibleNodes (0 when no active search). */
    hitCount: hitIndices.length,
    /** 0-based cursor into the hit list, -1 when no hit is focused. */
    currentOrdinal,
    goTo,
  };
}
