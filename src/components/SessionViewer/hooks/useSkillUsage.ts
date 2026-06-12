import { useEffect, useState } from "react";
import type { SessionSummary } from "../../../types";
import { api } from "../../../api";

/**
 * Skill usage rows fetched per session.
 *
 * Phase-1: claude-code only — opencode comes back empty (see core/src/stats.rs
 * for the phase-2 heuristic plan that would surface opencode skills too).
 *
 * Cancellation flag avoids a stale response from a prior session overwriting
 * the current one. Errors are non-fatal — the metric is just hidden.
 */
export function useSkillUsage(summary: SessionSummary | null) {
  const [skillUsage, setSkillUsage] = useState<
    Awaited<ReturnType<typeof api.sessionSkillUsage>>
  >([]);

  useEffect(() => {
    if (!summary) {
      setSkillUsage([]);
      return;
    }
    const { provider_id, source_path } = summary;
    let cancelled = false;
    api
      .sessionSkillUsage(provider_id, source_path)
      .then((rows) => {
        if (!cancelled) setSkillUsage(rows);
      })
      .catch(() => {
        if (!cancelled) setSkillUsage([]);
      });
    return () => {
      cancelled = true;
    };
  }, [summary]);

  return skillUsage;
}
