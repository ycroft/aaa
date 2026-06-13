import { useT } from "../../../i18n";
import type { BashCall } from "./rich-tools";
import { Highlight } from "./Highlight";

export function BashView({ data }: { data: BashCall }) {
  const t = useT();
  const cmdLines = data.command.split("\n");
  const tags: string[] = [];
  if (data.runInBackground) tags.push(t("viewer.bash.tag_background"));
  if (data.timeout != null) tags.push(t("viewer.bash.tag_timeout", { ms: data.timeout }));

  return (
    <div className="rich-view bash-view">
      <div className="rich-header">
        <span className="rich-variant">{t("viewer.bash.label")}</span>
        {data.description && (
          <span className="rich-subtitle" title={data.description}>
            <Highlight text={data.description} />
          </span>
        )}
        <span className="rich-spacer" />
        {tags.map((tag) => (
          <span key={tag} className="rich-tag">{tag}</span>
        ))}
      </div>
      <pre className="rich-pre bash-cmd">
        {cmdLines.map((line, i) => (
          <div key={i} className="bash-cmd-row">
            <span className="bash-prompt">{i === 0 ? "$" : ">"}</span>
            <span className="bash-line">{line ? <Highlight text={line} /> : " "}</span>
          </div>
        ))}
      </pre>
      {data.output && data.output.trim() !== "" && (
        <pre className="rich-pre bash-output"><Highlight text={data.output} /></pre>
      )}
    </div>
  );
}
