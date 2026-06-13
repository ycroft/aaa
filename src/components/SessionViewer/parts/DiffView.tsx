import { useMemo } from "react";
import { useT, type TKey } from "../../../i18n";
import type { NormalizedEdit, NormalizedFileEdit } from "./edit-detect";
import { Highlight } from "./Highlight";

// --- LCS line diff (small inputs only — bail to plain replace for very large blocks). ---

type DiffRow =
  | { tag: "ctx"; line: string }
  | { tag: "del"; line: string }
  | { tag: "add"; line: string };

const DIFF_LINE_BUDGET = 4000;

function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length + b.length > DIFF_LINE_BUDGET) {
    // Too big for an LCS — show as a wholesale replace (every old line removed, every new line added).
    const rows: DiffRow[] = [];
    for (const l of a) rows.push({ tag: "del", line: l });
    for (const l of b) rows.push({ tag: "add", line: l });
    return rows;
  }
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] vs b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ tag: "ctx", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ tag: "del", line: a[i] });
      i++;
    } else {
      rows.push({ tag: "add", line: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ tag: "del", line: a[i++] });
  while (j < m) rows.push({ tag: "add", line: b[j++] });
  return rows;
}

function statsOf(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.tag === "add") added++;
    else if (r.tag === "del") removed++;
  }
  return { added, removed };
}

function EditBlock({ edit, index, total }: { edit: NormalizedEdit; index: number; total: number }) {
  const t = useT();
  const rows = useMemo<DiffRow[]>(() => {
    if (edit.kind === "replace") return lineDiff(edit.oldText, edit.newText);
    if (edit.kind === "write") return edit.newText.split("\n").map((line) => ({ tag: "add", line }));
    return edit.oldText.split("\n").map((line) => ({ tag: "del", line }));
  }, [edit]);
  const { added, removed } = useMemo(() => statsOf(rows), [rows]);

  return (
    <div className="diff-block">
      {total > 1 && (
        <div className="diff-block-head">
          <span className="diff-hunk-label">
            {t("viewer.diff.hunk_label", { i: index + 1, n: total })}
          </span>
          {edit.kind === "replace" && edit.replaceAll && (
            <span className="diff-tag">{t("viewer.diff.replace_all")}</span>
          )}
          <span className="diff-stats">
            <span className="diff-stat-add">+{added}</span>
            <span className="diff-stat-del">-{removed}</span>
          </span>
        </div>
      )}
      <pre className="diff-pre">
        {rows.map((r, i) => (
          <div key={i} className={`diff-row diff-row-${r.tag}`}>
            <span className="diff-gutter">
              {r.tag === "add" ? "+" : r.tag === "del" ? "-" : " "}
            </span>
            <span className="diff-line">{r.line ? <Highlight text={r.line} /> : " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

export function DiffView({ data }: { data: NormalizedFileEdit }) {
  const t = useT();
  const totalStats = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const e of data.edits) {
      if (e.kind === "replace") {
        const r = lineDiff(e.oldText, e.newText);
        const s = statsOf(r);
        added += s.added;
        removed += s.removed;
      } else if (e.kind === "write") {
        added += e.newText.split("\n").length;
      } else {
        removed += e.oldText.split("\n").length;
      }
    }
    return { added, removed };
  }, [data]);

  const variantLabelKey: TKey =
    data.variant === "write"
      ? "viewer.diff.variant_write"
      : data.variant === "multi_edit"
      ? "viewer.diff.variant_multi"
      : data.variant === "notebook_edit"
      ? "viewer.diff.variant_notebook"
      : "viewer.diff.variant_edit";

  return (
    <div className="diff-view">
      <div className="diff-header">
        <span className="diff-variant">{t(variantLabelKey)}</span>
        <span className="diff-path mono">{data.filePath}</span>
        <span className="diff-stats">
          <span className="diff-stat-add">+{totalStats.added}</span>
          <span className="diff-stat-del">-{totalStats.removed}</span>
        </span>
      </div>
      {data.edits.map((e, i) => (
        <EditBlock key={i} edit={e} index={i} total={data.edits.length} />
      ))}
    </div>
  );
}
