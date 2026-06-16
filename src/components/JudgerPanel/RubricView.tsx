import { useI18n } from "../../i18n";
import type { Rubric } from "../../types";
import { ALL_DIMENSIONS } from "./dims";

interface Props {
  rubric: Rubric;
  onJumpToNode?: (nodeId: string) => void;
}

export function RubricView({ rubric, onJumpToNode }: Props) {
  const { t } = useI18n();
  const byDim = new Map(rubric.dimensions.map((d) => [d.dimension, d]));

  return (
    <div className="rubric-view">
      <div className={`overall ${rubric.overall}`}>
        {t(`judger.overall.${rubric.overall}` as const)}
      </div>
      <p className="summary">{rubric.summary}</p>

      {ALL_DIMENSIONS.map((dim) => {
        const d = byDim.get(dim);
        if (!d) return null;
        return (
          <section key={dim} className="dim-block">
            <h3>{t(`judger.dim.${dim}` as const)}</h3>
            {d.findings.length === 0 && <div className="muted">—</div>}
            {d.findings.map((f, i) => (
              <article key={i} className={`finding ${f.severity}`}>
                <header>
                  <span className={`sev ${f.severity}`}>
                    {t(`judger.severity.${f.severity}` as const)}
                  </span>
                  <strong>{f.title}</strong>
                </header>
                <p className="detail">{f.detail}</p>
                {f.evidence_node_ids.length > 0 && (
                  <div className="evidence">
                    {f.evidence_node_ids.map((id) => (
                      <button
                        key={id}
                        className="node-chip"
                        onClick={() => onJumpToNode?.(id)}
                        title={id}
                      >
                        {id.slice(0, 12)}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}
