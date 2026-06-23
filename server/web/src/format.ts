// Light helpers used across the UI.

export function providerLabel(p: { id: string; display_name: string }): string {
  if (p.id === "opencode") {
    return p.display_name + "（旧版兼容）";
  }
  return p.display_name;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(2) + "k";
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}

export function formatTps(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  return n < 100 ? n.toFixed(1) : Math.round(n).toString();
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / (1024 * 1024)).toFixed(2) + "MB";
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t0 = Date.parse(iso);
  if (Number.isNaN(t0)) return iso;
  const diff = (Date.now() - t0) / 1000;
  if (diff < 60) return `${Math.floor(diff)}秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 86_400 * 30) return `${Math.floor(diff / 86_400)}天前`;
  const d = new Date(t0);
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

export function compactMiddlePath(p: string, maxLen = 72): string {
  if (p.length <= maxLen) return p;
  const segs = p.split(/[\\/]/);
  const sepMatch = p.match(/[\\/]/);
  const sep = sepMatch ? sepMatch[0] : "/";
  if (segs.length >= 4) {
    const headCount = segs[0] === "" ? 2 : 1;
    const head = segs.slice(0, headCount).join(sep);
    const tail = segs.slice(-2).join(sep);
    const candidate = `${head}${sep}…${sep}${tail}`;
    if (candidate.length <= maxLen) return candidate;
    const tailOnly = `…${sep}${tail}`;
    if (tailOnly.length <= maxLen) return tailOnly;
  }
  const keep = Math.max(8, maxLen - 1);
  const headChars = Math.ceil(keep / 2);
  const tailChars = keep - headChars;
  return `${p.slice(0, headChars)}…${p.slice(p.length - tailChars)}`;
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

export function sanitizeFileName(title: string | null | undefined, sessionId: string): string {
  let raw = (title && title.trim()) ? title : sessionId;
  raw = raw.replace(/[\s　]+/g, "_");
  raw = raw.replace(/[/\\:*?"<>|\x00-\x1f]+/g, "_");
  raw = raw.replace(/_+/g, "_");
  raw = raw.replace(/^[_.]+|[_.]+$/g, "");
  raw = raw.slice(0, 120);
  if (!raw) raw = `session_${sessionId.slice(0, 8)}`;
  return raw;
}

export function exportTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
