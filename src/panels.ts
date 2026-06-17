import type { ActiveBackend } from "./components/SessionPanel";

export type PanelKind = "session" | "judger" | "feedback";

export const JUDGER_PANEL_IDENTITY = "judger";
export const JUDGER_PANEL_TITLE_KEY = "judger.tab_title";

export const FEEDBACK_PANEL_IDENTITY = "feedback";
export const FEEDBACK_PANEL_TITLE_KEY = "feedback_panel.tab_title";

/** Identity used to dedupe panels when the user re-opens the same source from
 *  the splash. Local backends are scoped by (provider, root); remote backends
 *  by (provider, remoteId). The judger and feedback panels are global
 *  singletons with constant identities. */
export function panelIdentity(active: ActiveBackend): string {
  if (active.remote) return `remote::${active.remote.id}::${active.provider.id}`;
  return `local::${active.provider.id}::${active.root}`;
}

/** App-level metadata about a panel. Three kinds today: session (one per
 *  data source), judger (global singleton), feedback (global singleton). */
export interface PanelDescriptor {
  id: string;
  identity: string;
  kind: PanelKind;
  title: string;
  subtitle: string | null;
  icon: string;
  /** null when kind === "judger" or "feedback". */
  backend: ActiveBackend | null;
}
