import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { MessagePart, SessionNode } from "../../../types";

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

export function useMessageSearch(
  visibleNodes: SessionNode[],
  bodyRef: RefObject<HTMLDivElement | null>,
  forceExpand: (nodeId: string) => void,
) {
  const [messageSearch, setMessageSearch] = useState("");
  const [searchMissed, setSearchMissed] = useState(false);
  const [activeHighlight, setActiveHighlight] = useState("");
  const [currentOrdinal, setCurrentOrdinal] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);

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

    let nextOrdinal = 0;
    if (needle === activeHighlight && currentOrdinal >= 0) {
      nextOrdinal = (currentOrdinal + 1) % hits.length;
    } else {
      setActiveHighlight(needle);
    }
    setCurrentOrdinal(nextOrdinal);
    focusHit(hits[nextOrdinal]);
  }, [messageSearch, visibleNodes, bodyRef, activeHighlight, currentOrdinal, focusHit]);

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
    hitCount: hitIndices.length,
    currentOrdinal,
    goTo,
  };
}
