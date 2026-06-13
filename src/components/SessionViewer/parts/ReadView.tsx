import { useMemo } from "react";
import { useT } from "../../../i18n";
import type { ReadCall } from "./rich-tools";

// claude-code's Read tool returns each line prefixed with "    NN\t" (cat -n style).
// We split that into a (lineNo, code) tuple per row so the renderer can show a
// dedicated gutter. Lines that don't match the pattern fall through as plain text.
const NUMBERED_LINE_RE = /^\s*(\d+)\t(.*)$/;

interface NumberedRow {
  no: number | null;
  text: string;
}

function parseNumbered(output: string): NumberedRow[] {
  return output.split("\n").map((line) => {
    const m = line.match(NUMBERED_LINE_RE);
    if (m) return { no: Number(m[1]), text: m[2] };
    return { no: null, text: line };
  });
}

export function ReadView({ data }: { data: ReadCall }) {
  const t = useT();
  const range =
    data.offset != null || data.limit != null
      ? t("viewer.read.range", {
          from: data.offset ?? 1,
          to: data.limit != null ? (data.offset ?? 1) + data.limit - 1 : "…",
        })
      : null;

  const rows = useMemo(
    () => (data.output ? parseNumbered(data.output) : []),
    [data.output],
  );
  const hasNumbered = rows.some((r) => r.no != null);

  return (
    <div className="rich-view read-view">
      <div className="rich-header">
        <span className="rich-variant">{t("viewer.read.label")}</span>
        <span className="rich-path mono" title={data.filePath}>{data.filePath}</span>
        {range && <span className="rich-tag">{range}</span>}
      </div>
      {data.output ? (
        hasNumbered ? (
          <pre className="rich-pre read-numbered">
            {rows.map((r, i) => (
              <div key={i} className="read-row">
                <span className="read-gutter">{r.no ?? ""}</span>
                <span className="read-line">{r.text || " "}</span>
              </div>
            ))}
          </pre>
        ) : (
          <pre className="rich-pre">{data.output}</pre>
        )
      ) : (
        <div className="rich-empty">{t("viewer.read.output_in_result")}</div>
      )}
    </div>
  );
}
