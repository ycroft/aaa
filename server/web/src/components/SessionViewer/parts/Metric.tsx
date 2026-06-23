import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

const DEFAULT_MIN_WIDTH = 180;
const DEFAULT_MAX_WIDTH = 320;
const VIEWPORT_MARGIN = 16;

type Anchor = "left" | "right";

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
    const roomLeftAnchored = vw - rect.left - VIEWPORT_MARGIN;
    const roomRightAnchored = rect.right - VIEWPORT_MARGIN;
    let anchor: Anchor;
    if (roomLeftAnchored >= maxW) anchor = "left";
    else if (roomRightAnchored >= maxW) anchor = "right";
    else anchor = roomLeftAnchored >= roomRightAnchored ? "left" : "right";
    const room = anchor === "left" ? roomLeftAnchored : roomRightAnchored;
    const floor = Math.min(minW, vw - 2 * VIEWPORT_MARGIN);
    const cap = Math.max(Math.min(maxW, room), floor);
    setTipStyle({
      left: anchor === "left" ? 0 : "auto",
      right: anchor === "right" ? 0 : "auto",
      minWidth: Math.min(minW, cap),
      maxWidth: cap,
    });
  }, [minW, maxW]);

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
