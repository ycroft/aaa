import { useState } from "react";
import type { ProviderInfo, RemoteCacheInfo, RemoteHostInfo, RemoteProviderInfo } from "../types";
import { shortPath } from "../format";
import { api } from "../api";

interface Props {
  open: boolean;
  providers: ProviderInfo[];
  remotes: RemoteHostInfo[];
  onPick: (p: ProviderInfo, customRoot?: string) => void;
  onCustom: (p: ProviderInfo) => void;
  onPickRemote: (remote: RemoteHostInfo, providerId: string) => void;
  /** Open a previously-synced cache without re-connecting. */
  onPickRemoteCache: (remote: RemoteHostInfo, providerId: string, localRoot: string) => void;
  onAddRemote: () => void;
  onClose?: () => void;
  closable?: boolean;
}

export function ProviderSplash({
  open,
  providers,
  remotes,
  onPick,
  onCustom,
  onPickRemote,
  onPickRemoteCache,
  onAddRemote,
  onClose,
  closable,
}: Props) {
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => closable && e.target === e.currentTarget && onClose?.()}>
      <div className="splash">
        <div className="panel" data-hint="Pick a backend whose sessions you want to analyze">
          <h1>Choose a session source</h1>
          <p className="lead">
            AAA inspects logs from AI coding agents. Pick a local backend or a remote host.
            You can switch later from
            <span className="kbd" style={{ margin: "0 6px" }}>File</span>
            <span style={{ color: "var(--text-3)" }}>· Switch backend…</span>
          </p>

          <h3 style={{ marginTop: 4, marginBottom: 8, fontSize: 13, color: "var(--text-2)" }}>Local</h3>
          <div className="provider-grid">
            {providers.map((p) => {
              const tag = !p.is_implemented
                ? <span className="tag todo">coming soon</span>
                : p.root_exists
                  ? <span className="tag ok">ready</span>
                  : <span className="tag miss">no data found</span>;
              const canPick = p.is_implemented;
              return (
                <div
                  key={p.id}
                  className={`provider-card${canPick ? "" : " disabled"}`}
                  data-hint={canPick
                    ? `Use ${p.display_name}; defaults to scanning ${p.default_root ?? "(no path)"}`
                    : `${p.display_name} support is not yet implemented`}
                  onClick={() => canPick && onPick(p)}
                >
                  <div className="pname">
                    <span>{p.display_name}</span>
                    {tag}
                  </div>
                  <div className="root">{shortPath(p.default_root, 96)}</div>
                  {canPick && (
                    <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                      <button
                        className="btn primary"
                        onClick={(e) => { e.stopPropagation(); onPick(p); }}
                        data-hint="Use the default directory shown above"
                      >
                        Open default
                      </button>
                      <button
                        className="btn"
                        onClick={(e) => { e.stopPropagation(); onCustom(p); }}
                        data-hint="Pick a custom directory containing this provider's logs"
                      >
                        Pick directory…
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 20, marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontSize: 13, color: "var(--text-2)" }}>Remote</h3>
            <button className="btn" onClick={onAddRemote} data-hint="Add or manage remote hosts">+ Add / Manage</button>
          </div>
          {remotes.length === 0 && (
            <div className="help" style={{ marginBottom: 12 }}>
              No remote hosts configured. Click "+ Add / Manage" to add one.
            </div>
          )}
          {remotes.map((r) => (
            <RemoteRow
              key={r.id}
              remote={r}
              providers={providers}
              onPick={(pid) => onPickRemote(r, pid)}
              onPickCache={(pid, localRoot) => onPickRemoteCache(r, pid, localRoot)}
            />
          ))}

          <div className="actions">
            <div className="grow" />
            {closable && (
              <button className="btn" onClick={onClose}>Cancel</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RemoteRow({
  remote,
  providers,
  onPick,
  onPickCache,
}: {
  remote: RemoteHostInfo;
  providers: ProviderInfo[];
  onPick: (providerId: string) => void;
  onPickCache: (providerId: string, localRoot: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probed, setProbed] = useState<RemoteProviderInfo[] | null>(null);
  const [caches, setCaches] = useState<RemoteCacheInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function expand() {
    setExpanded(true);
    if (probed || probing) return;
    setProbing(true);
    setErr(null);
    // Start probe + cache lookup in parallel; cache list is local so it's
    // basically instant, but treat it as best-effort — a missing cache is
    // not an error worth surfacing.
    const cachePromise = api.listRemoteCaches(remote.id).catch(() => [] as RemoteCacheInfo[]);
    try {
      const r = await api.remoteProbe(remote.id);
      setProbed(r);
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setProbing(false);
    }
    setCaches(await cachePromise);
  }

  return (
    <div
      className="provider-card"
      style={{ marginBottom: 8 }}
    >
      <div
        onClick={expanded ? () => setExpanded(false) : () => void expand()}
        style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}
      >
        <span>{expanded ? "▾" : "▸"}</span>
        <strong>{remote.label}</strong>
        <span className="root" style={{ flex: 1 }}>{remote.user}@{remote.host}:{remote.port}</span>
        {!remote.host_key_known && (
          <span className="tag miss">untrusted host key</span>
        )}
      </div>
      {expanded && (
        <div style={{ marginTop: 10, marginLeft: 18 }}>
          {probing && <div className="help">Probing…</div>}
          {err && <div className="help" style={{ color: "var(--err, #e0533c)" }}>{err}</div>}
          {probed && probed.length === 0 && <div className="help">No backends discovered.</div>}
          {probed && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {probed.map((rp) => {
                const provider = providers.find((p) => p.id === rp.provider_id);
                if (!provider) return null;
                const cache = caches?.find((c) => c.provider_id === rp.provider_id) ?? null;
                const remoteUsable = rp.exists && provider.is_implemented;
                const remoteTitle = !provider.is_implemented
                  ? "Backend not implemented yet"
                  : !rp.exists
                  ? "No log directory found on remote — set provider_root_overrides in Settings"
                  : `Connect to ${remote.label} and re-sync ${provider.display_name}`;
                const cacheUsable = !!cache && provider.is_implemented;
                const cacheTitle = cache
                  ? `Open cached snapshot — ${formatBytes(cache.size_bytes)}` +
                    (cache.last_modified ? `, synced ${formatTime(cache.last_modified)}` : "")
                  : "No local cache yet — connect once to populate it";
                return (
                  <div key={rp.provider_id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ minWidth: 100, color: "var(--text-2)" }}>
                      {provider.display_name}
                      {!provider.is_implemented && " (stub)"}
                    </span>
                    <button
                      className={"btn" + (remoteUsable ? " primary" : "")}
                      disabled={!remoteUsable}
                      title={remoteTitle}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (remoteUsable) onPick(rp.provider_id);
                      }}
                    >
                      ↻ Connect &amp; sync
                    </button>
                    <button
                      className="btn"
                      disabled={!cacheUsable}
                      title={cacheTitle}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (cacheUsable && cache) onPickCache(rp.provider_id, cache.local_root);
                      }}
                    >
                      💾 Open cache
                      {cache && (
                        <span style={{ marginLeft: 6, color: "var(--text-3)", fontSize: 11 }}>
                          {formatBytes(cache.size_bytes)}
                          {cache.last_modified ? ` · ${formatTime(cache.last_modified)}` : ""}
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
