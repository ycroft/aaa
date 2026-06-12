import { useState } from "react";
import type { ProviderInfo, RemoteCacheInfo, RemoteHostInfo, RemoteProviderInfo } from "../types";
import { shortPath } from "../format";
import { api } from "../api";
import { useT } from "../i18n";

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
  const t = useT();
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => closable && e.target === e.currentTarget && onClose?.()}>
      <div className="splash">
        <div className="panel" data-hint={t("splash.panel_hint")}>
          <h1>{t("splash.title")}</h1>
          <p className="lead">
            {t("splash.lead_prefix")}
            <span className="kbd" style={{ margin: "0 6px" }}>{t("splash.lead_file_menu")}</span>
            <span style={{ color: "var(--text-3)" }}>{t("splash.lead_suffix")}</span>
          </p>

          <h3 style={{ marginTop: 4, marginBottom: 8, fontSize: 13, color: "var(--text-2)" }}>{t("splash.local")}</h3>
          <div className="provider-grid">
            {providers.map((p) => {
              const tag = !p.is_implemented
                ? <span className="tag todo">{t("splash.tag_coming_soon")}</span>
                : p.root_exists
                  ? <span className="tag ok">{t("splash.tag_ready")}</span>
                  : <span className="tag miss">{t("splash.tag_no_data")}</span>;
              const canPick = p.is_implemented;
              return (
                <div
                  key={p.id}
                  className={`provider-card${canPick ? "" : " disabled"}`}
                  data-hint={canPick
                    ? t("splash.use_provider_hint", { name: p.display_name, root: p.default_root ?? t("splash.no_path") })
                    : t("splash.not_implemented_hint", { name: p.display_name })}
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
                        data-hint={t("splash.pick_default_hint")}
                      >
                        {t("splash.pick_default")}
                      </button>
                      <button
                        className="btn"
                        onClick={(e) => { e.stopPropagation(); onCustom(p); }}
                        data-hint={t("splash.pick_custom_hint")}
                      >
                        {t("splash.pick_custom")}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 20, marginBottom: 8 }}>
            <h3 style={{ margin: 0, fontSize: 13, color: "var(--text-2)" }}>{t("splash.remote")}</h3>
            <button className="btn" onClick={onAddRemote} data-hint={t("splash.add_manage_hint")}>{t("splash.add_manage")}</button>
          </div>
          {remotes.length === 0 && (
            <div className="help" style={{ marginBottom: 12 }}>
              {t("splash.no_remotes")}
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
              <button className="btn" onClick={onClose}>{t("splash.cancel")}</button>
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
  const t = useT();
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
          <span className="tag miss">{t("splash.untrusted_host_key")}</span>
        )}
      </div>
      {expanded && (
        <div style={{ marginTop: 10, marginLeft: 18 }}>
          {probing && <div className="help">{t("splash.probing")}</div>}
          {err && <div className="help" style={{ color: "var(--err, #e0533c)" }}>{err}</div>}
          {probed && probed.length === 0 && <div className="help">{t("splash.no_backends")}</div>}
          {probed && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {probed.map((rp) => {
                const provider = providers.find((p) => p.id === rp.provider_id);
                if (!provider) return null;
                const cache = caches?.find((c) => c.provider_id === rp.provider_id) ?? null;
                const remoteUsable = rp.exists && provider.is_implemented;
                const remoteTitle = !provider.is_implemented
                  ? t("splash.backend_not_implemented")
                  : !rp.exists
                  ? t("splash.no_log_dir")
                  : t("splash.connect_and_resync", { label: remote.label, provider: provider.display_name });
                const cacheUsable = !!cache && provider.is_implemented;
                const cacheTitle = cache
                  ? t("splash.open_cached_snapshot", { size: formatBytes(cache.size_bytes) }) +
                    (cache.last_modified ? t("splash.synced_at", { time: formatTime(cache.last_modified) }) : "")
                  : t("splash.no_local_cache");
                return (
                  <div key={rp.provider_id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ minWidth: 100, color: "var(--text-2)" }}>
                      {provider.display_name}
                      {!provider.is_implemented && t("splash.stub_suffix")}
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
                      {t("splash.connect_sync")}
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
                      {t("splash.open_cache")}
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
