import type { ActiveBackend } from "./components/SessionPanel";

/** Identity used to dedupe panels when the user re-opens the same source from
 *  the splash. Local backends are scoped by (provider, root); remote backends
 *  by (provider, remoteId) so a re-sync of the same host doesn't fork a new
 *  tab. */
export function panelIdentity(active: ActiveBackend): string {
  if (active.remote) return `remote::${active.remote.id}::${active.provider.id}`;
  return `local::${active.provider.id}::${active.root}`;
}

/** App-level metadata about a panel. The session panel itself owns its
 *  internal state; this is just enough to render the tab label and the
 *  status bar. Today every panel is a session panel — the descriptor is
 *  factored out so future kinds (e.g. a team dashboard) can plug in here
 *  without churning App.tsx. */
export interface PanelDescriptor {
  id: string;
  /** Stable key derived from backend identity, used by `panelIdentity` to
   *  dedupe re-opens of the same source. */
  identity: string;
  title: string;
  subtitle: string | null;
  /** One-character glyph rendered in the tab. ↗ = remote, ▣ = local. */
  icon: string;
  backend: ActiveBackend;
}
