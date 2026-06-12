// Light helpers used across the UI.

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(2) + "k";
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / (1024 * 1024)).toFixed(2) + "MB";
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86_400 * 30) return `${Math.floor(diff / 86_400)}d ago`;
  const d = new Date(t);
  return d.toISOString().slice(0, 10);
}

export function formatLocalTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function shortPath(p: string | null | undefined, maxLen = 64): string {
  if (!p) return "—";
  if (p.length <= maxLen) return p;
  const head = p.slice(0, 18);
  const tail = p.slice(p.length - (maxLen - 18 - 3));
  return `${head}…${tail}`;
}

export function compactPreview(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + "…";
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec ? `${totalMin}m${sec}s` : `${totalMin}m`;
  const totalHr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (totalHr < 24) return min ? `${totalHr}h${min}m` : `${totalHr}h`;
  const day = Math.floor(totalHr / 24);
  const hr = totalHr % 24;
  return hr ? `${day}d${hr}h` : `${day}d`;
}

export function formatPercent(part: number, whole: number | null | undefined): string {
  if (whole == null || !Number.isFinite(whole) || whole <= 0) return "—";
  const p = (part / whole) * 100;
  if (p >= 100) return "100%";
  if (p < 0.1) return "<0.1%";
  return `${p.toFixed(1)}%`;
}

/**
 * Sanitize a session title into a filesystem-safe file name segment.
 * Falls back to sessionId if title is empty/blank.
 */
export function sanitizeFileName(title: string | null | undefined, sessionId: string): string {
  let raw = (title && title.trim()) ? title : sessionId;

  // Replace all whitespace (including fullwidth space, tabs, newlines) with _
  raw = raw.replace(/[\s\u3000]+/g, "_");

  // Replace filesystem-illegal characters and control chars with _
  raw = raw.replace(/[/\\:*?"<>|\x00-\x1f]+/g, "_");

  // Collapse consecutive underscores
  raw = raw.replace(/_+/g, "_");

  // Trim leading/trailing _ and .
  raw = raw.replace(/^[_.]+|[_.]+$/g, "");

  // Truncate to 120 chars
  raw = raw.slice(0, 120);

  // Final fallback if empty after sanitization
  if (!raw) {
    raw = `session_${sessionId.slice(0, 8)}`;
  }

  return raw;
}

/**
 * Return a timestamp string suitable for export file names: YYYY-MM-DD_HHMMSS (local time).
 */
export function exportTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
