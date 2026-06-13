//! Tokens-per-second aggregation across assistant turns.
//!
//! Two layers:
//!   - per-agent: walk an agent's nodes (parent or sub-agent), produce
//!     [`TpsMetrics`] + a forward-filled [`TpsSeriesPoint`] series for the
//!     curve in the UI.
//!   - per-session: union the parent agent with all `Normal` sub-agents,
//!     re-sort by timestamp, recompute metrics. No series for this layer —
//!     a curve mixing parent and sub-agent timelines isn't meaningful.
//!
//! Qualification thresholds live here as constants so we have one place to
//! tune them. The semantics of `generation_duration_ms` itself differ by
//! provider — see the docstring on `TokenUsage::generation_duration_ms`.

use std::collections::HashMap;

use crate::model::{
    AgentTps, NodeKind, SessionDetail, SessionNode, SubAgentKind, TpsMetrics, TpsSeriesPoint,
};

/// Sentinel agent_id under which the parent agent's metrics live in
/// `SessionDetail.tps_per_agent`. Chosen so it can never collide with a real
/// claude-code or opencode session id (both are uuid/nanoid-shaped).
pub const MAIN_AGENT_KEY: &str = "<main>";

/// Minimum output tokens for a node to qualify for TPS computation.
///
/// Tunes out cache-heavy short replies where output is dominated by a
/// 1-token "OK" while input/context is huge — those produce wildly variable
/// TPS that aren't representative of generation speed.
const MIN_OUTPUT_TOKENS: u64 = 50;

/// Minimum generation duration (ms). Sub-second turns are noisy because the
/// timestamp resolution is per-millisecond and small absolute errors in the
/// timestamp pipeline (clock skew, timer batching) blow up the ratio.
const MIN_DURATION_MS: u64 = 1000;

/// Compute the agent-level TPS rollup for a single ordered timeline.
///
/// Series ordering matches `nodes` (caller is responsible for sorting). The
/// forward-fill rule: for each assistant node we either push the just-computed
/// TPS or copy the most recent valid one as `interpolated = true`. Non-assistant
/// nodes are skipped entirely (they don't appear on the curve). Until the
/// first qualifying node appears we don't emit any points — that avoids a
/// flat zero line at the start of agents with only short opening turns.
pub fn compute_agent_tps(nodes: &[SessionNode]) -> AgentTps {
    let mut samples: Vec<f64> = Vec::new();
    let mut total_output: u64 = 0;
    let mut total_duration: u64 = 0;
    let mut excluded: u32 = 0;

    let mut series: Vec<TpsSeriesPoint> = Vec::new();
    let mut last_valid_tps: Option<f64> = None;

    for n in nodes {
        if !is_assistant(n) {
            continue;
        }
        let usage = match &n.usage {
            Some(u) => u,
            None => continue, // assistant without usage — nothing to score on
        };
        let dur = usage.generation_duration_ms;

        let qualifies = dur.is_some()
            && usage.output_tokens >= MIN_OUTPUT_TOKENS
            && dur.unwrap() >= MIN_DURATION_MS;

        if qualifies {
            // Safe: qualifies guarantees dur.is_some() and dur >= 1000.
            let dur_ms = dur.unwrap();
            let tps = (usage.output_tokens as f64) / (dur_ms as f64 / 1000.0);
            samples.push(tps);
            total_output += usage.output_tokens;
            total_duration += dur_ms;
            series.push(TpsSeriesPoint {
                node_id: n.id.clone(),
                tps,
                interpolated: false,
            });
            last_valid_tps = Some(tps);
        } else {
            // Even if usage is present but fails the gate (e.g. a cache-only
            // 5-token "OK"), it counts as "excluded" only when there *was*
            // some duration data to evaluate. Pure no-data assistants stay
            // out of both buckets.
            if dur.is_some() {
                excluded += 1;
            }
            if let Some(prev) = last_valid_tps {
                series.push(TpsSeriesPoint {
                    node_id: n.id.clone(),
                    tps: prev,
                    interpolated: true,
                });
            }
            // else: drop the point — no valid value to fill from yet.
        }
    }

    let metrics = build_metrics(&samples, total_output, total_duration, excluded);
    AgentTps { metrics, series }
}

/// Session-wide rollup. Combines parent + every `Normal` sub-agent, re-sorts
/// by timestamp, then runs the same qualification rules. We don't emit a
/// series here — see module docstring for why.
pub fn compute_session_tps(detail: &SessionDetail) -> Option<TpsMetrics> {
    let mut combined: Vec<&SessionNode> = detail.nodes.iter().collect();
    for sa in &detail.subagents {
        if sa.kind != SubAgentKind::Normal {
            continue; // AsideQuestion mirrors the parent — would double-count.
        }
        combined.extend(sa.nodes.iter());
    }
    // Sort by timestamp string (ISO-8601 sorts lexicographically) so the
    // walk order matches actual wall-clock order even when nodes from
    // different agents interleave. Nodes without timestamps fall to the end.
    combined.sort_by(|a, b| match (&a.timestamp, &b.timestamp) {
        (Some(x), Some(y)) => x.cmp(y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    let mut samples: Vec<f64> = Vec::new();
    let mut total_output: u64 = 0;
    let mut total_duration: u64 = 0;
    let mut excluded: u32 = 0;

    for n in &combined {
        if !is_assistant(n) {
            continue;
        }
        let usage = match &n.usage {
            Some(u) => u,
            None => continue,
        };
        let Some(dur_ms) = usage.generation_duration_ms else {
            continue;
        };
        if usage.output_tokens >= MIN_OUTPUT_TOKENS && dur_ms >= MIN_DURATION_MS {
            let tps = (usage.output_tokens as f64) / (dur_ms as f64 / 1000.0);
            samples.push(tps);
            total_output += usage.output_tokens;
            total_duration += dur_ms;
        } else {
            excluded += 1;
        }
    }

    let m = build_metrics(&samples, total_output, total_duration, excluded);
    if m.sample_count == 0 && excluded == 0 {
        None
    } else {
        Some(m)
    }
}

/// Compute the parent + per-subagent rollups in one call. Returned map is
/// keyed by [`MAIN_AGENT_KEY`] for the parent and by `agent_id` for each
/// sub-agent (Normal kind only — aside/compact subagents are excluded
/// because they're either mirrors or snapshots, not separate workloads).
pub fn compute_per_agent_tps(detail: &SessionDetail) -> HashMap<String, AgentTps> {
    let mut out = HashMap::new();
    out.insert(MAIN_AGENT_KEY.to_string(), compute_agent_tps(&detail.nodes));
    for sa in &detail.subagents {
        if sa.kind != SubAgentKind::Normal {
            continue;
        }
        out.insert(sa.agent_id.clone(), compute_agent_tps(&sa.nodes));
    }
    out
}

fn is_assistant(n: &SessionNode) -> bool {
    matches!(n.kind, NodeKind::Assistant)
}

fn build_metrics(
    samples: &[f64],
    total_output: u64,
    total_duration: u64,
    excluded: u32,
) -> TpsMetrics {
    if samples.is_empty() {
        return TpsMetrics {
            tps_mean: None,
            tps_median: None,
            sample_count: 0,
            total_output_tokens: total_output,
            total_generation_ms: total_duration,
            excluded_count: excluded,
        };
    }
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = if sorted.len() % 2 == 1 {
        sorted[sorted.len() / 2]
    } else {
        let mid = sorted.len() / 2;
        (sorted[mid - 1] + sorted[mid]) / 2.0
    };
    TpsMetrics {
        tps_mean: Some(mean),
        tps_median: Some(median),
        sample_count: samples.len() as u32,
        total_output_tokens: total_output,
        total_generation_ms: total_duration,
        excluded_count: excluded,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{MessagePart, SessionNode, TokenUsage};

    fn assistant(id: &str, out: u64, dur_ms: Option<u64>) -> SessionNode {
        SessionNode {
            id: id.to_string(),
            parent_id: None,
            kind: NodeKind::Assistant,
            timestamp: Some(format!("2026-01-01T00:00:{:02}.000Z", id.len())),
            model: None,
            parts: vec![MessagePart::Text { text: "x".into() }],
            usage: Some(TokenUsage {
                input_tokens: 10,
                output_tokens: out,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                service_tier: None,
                generation_duration_ms: dur_ms,
            }),
            cumulative_context_tokens: None,
            raw_size_bytes: 0,
        }
    }

    fn user(id: &str) -> SessionNode {
        SessionNode {
            id: id.to_string(),
            parent_id: None,
            kind: NodeKind::User,
            timestamp: Some("2026-01-01T00:00:00.000Z".into()),
            model: None,
            parts: vec![MessagePart::Text { text: "u".into() }],
            usage: None,
            cumulative_context_tokens: None,
            raw_size_bytes: 0,
        }
    }

    #[test]
    fn empty_input_returns_no_metric() {
        let r = compute_agent_tps(&[]);
        assert!(r.metrics.tps_mean.is_none());
        assert_eq!(r.metrics.sample_count, 0);
        assert!(r.series.is_empty());
    }

    #[test]
    fn skips_user_and_unusable_nodes() {
        // user + assistant-without-duration + short-output
        let nodes = vec![
            user("u"),
            assistant("a", 100, None),
            assistant("b", 10, Some(2000)),
        ];
        let r = compute_agent_tps(&nodes);
        assert_eq!(r.metrics.sample_count, 0);
        // "b" was excluded (had duration but failed token gate); "a" lacked
        // duration entirely so it doesn't even count as excluded.
        assert_eq!(r.metrics.excluded_count, 1);
    }

    #[test]
    fn forward_fills_after_first_valid_point() {
        let nodes = vec![
            // First two: under token threshold but with duration → excluded.
            assistant("p1", 5, Some(2000)),
            assistant("p2", 10, Some(3000)),
            // First qualifying turn: 100 tok / 2 s = 50 t/s.
            assistant("good", 100, Some(2000)),
            // Sub-second after good: forward-filled to 50 t/s, interpolated.
            assistant("short", 200, Some(500)),
            // Another qualifying: 200 tok / 2 s = 100 t/s.
            assistant("good2", 200, Some(2000)),
        ];
        let r = compute_agent_tps(&nodes);
        assert_eq!(r.metrics.sample_count, 2);
        let mean = r.metrics.tps_mean.unwrap();
        assert!((mean - 75.0).abs() < 0.001, "mean was {mean}");
        // Series: p1/p2 dropped (no prior valid point), good (50, real),
        // short (50, interpolated), good2 (100, real).
        assert_eq!(r.series.len(), 3);
        assert_eq!(r.series[0].node_id, "good");
        assert!(!r.series[0].interpolated);
        assert!((r.series[0].tps - 50.0).abs() < 0.001);
        assert_eq!(r.series[1].node_id, "short");
        assert!(r.series[1].interpolated);
        assert!((r.series[1].tps - 50.0).abs() < 0.001);
        assert_eq!(r.series[2].node_id, "good2");
        assert!(!r.series[2].interpolated);
        assert!((r.series[2].tps - 100.0).abs() < 0.001);
    }

    #[test]
    fn median_with_even_count_averages_middle_pair() {
        // 4 turns: 50, 100, 150, 200 t/s — median = (100+150)/2 = 125.
        let nodes = vec![
            assistant("a", 100, Some(2000)),  // 50
            assistant("b", 200, Some(2000)),  // 100
            assistant("c", 300, Some(2000)),  // 150
            assistant("d", 400, Some(2000)),  // 200
        ];
        let r = compute_agent_tps(&nodes);
        assert_eq!(r.metrics.sample_count, 4);
        let med = r.metrics.tps_median.unwrap();
        assert!((med - 125.0).abs() < 0.001, "median was {med}");
    }
}
