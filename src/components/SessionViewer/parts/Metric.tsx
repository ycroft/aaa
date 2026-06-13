import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

// Default tooltip dimensions when the caller doesn't override. Matches the
// pre-refactor `.metric-tooltip` defaults so the small tool-breakdown / skill
// tooltips look identical.
const DEFAULT_MIN_WIDTH = 180;
const DEFAULT_MAX_WIDTH = 320;
// Viewport edge breathing room — the tooltip will never come closer than
// this to either edge, regardless of preferred width.
const VIEWPORT_MARGIN = 16;

type Anchor = "left" | "right";

// Smart-positioning Metric chip: when the chip is hovered/focused we measure
// its viewport position and decide whether the tooltip anchors to the chip's
// left edge (growing rightward) or right edge (growing leftward), picking
// whichever side has more room. The effective width is clamped to what the
// viewport can hold so wide tooltips can't overflow horizontally regardless
// of where the chip sits in the metric grid.
//
// Callers that need a wider tooltip (file lists, line charts) pass
// `tooltipMinWidth` / `tooltipMaxWidth`. Edge avoidance is handled uniformly
// here, so per-variant CSS overrides are no longer needed.
export function Metric({
  label,
  value,
  tooltip,
  tooltipMinWidth,
  tooltipMaxWidth,
}: {
  label: string;
  value: string;
  tooltip?: ReactNode;
  tooltipMinWidth?: number;
  tooltipMaxWidth?: number;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [tipStyle, setTipStyle] = useState<CSSProperties | null>(null);

  const minW = tooltipMinWidth ?? DEFAULT_MIN_WIDTH;
  const maxW = tooltipMaxWidth ?? DEFAULT_MAX_WIDTH;

  const recompute = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    // Available room for each anchor, leaving a viewport-edge margin.
    const roomLeftAnchored = vw - rect.left - VIEWPORT_MARGIN;
    const roomRightAnchored = rect.right - VIEWPORT_MARGIN;
    // Prefer whichever side fits the requested max. If neither fits, use the
    // side with more room and let the cap below shrink the tooltip.
    let anchor: Anchor;
    if (roomLeftAnchored >= maxW) anchor = "left";
    else if (roomRightAnchored >= maxW) anchor = "right";
    else anchor = roomLeftAnchored >= roomRightAnchored ? "left" : "right";
    const room = anchor === "left" ? roomLeftAnchored : roomRightAnchored;
    // Cap to available room, but never below an absolute floor (the smaller
    // of minW and the viewport-minus-margins so we don't blow past the screen).
    const floor = Math.min(minW, vw - 2 * VIEWPORT_MARGIN);
    const cap = Math.max(Math.min(maxW, room), floor);
    setTipStyle({
      left: anchor === "left" ? 0 : "auto",
      right: anchor === "right" ? 0 : "auto",
      minWidth: Math.min(minW, cap),
      maxWidth: cap,
    });
  }, [minW, maxW]);

  // Recompute when the tooltip opens and on resize while it's visible. We
  // don't subscribe to scroll because the metric grid lives in a non-scrolling
  // header; resize matters because it shifts the chip relative to the right
  // edge.
  useLayoutEffect(() => {
    if (!open) return;
    recompute();
    const onResize = () => recompute();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, recompute]);

  return (
    <div
      ref={rootRef}
      className={`metric${tooltip ? " has-tooltip" : ""}`}
      onMouseEnter={tooltip ? () => setOpen(true) : undefined}
      onMouseLeave={tooltip ? () => setOpen(false) : undefined}
      onFocus={tooltip ? () => setOpen(true) : undefined}
      onBlur={tooltip ? () => setOpen(false) : undefined}
    >
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {tooltip && open && tipStyle && (
        <div className="metric-tooltip" style={tipStyle}>{tooltip}</div>
      )}
    </div>
  );
}
