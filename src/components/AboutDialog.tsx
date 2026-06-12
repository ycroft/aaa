import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppInfo } from "../types";
import { useT } from "../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AboutDialog({ open, onClose }: Props) {
  const t = useT();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api
      .getAppInfo()
      .then(setInfo)
      .catch((e) => setError(String(e)));
  }, [open]);

  if (!open) return null;

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" data-hint={t("about.title")} style={{ maxWidth: 560, width: "100%" }}>
        <div className="modal-head">
          <div className="title">{t("about.title")}</div>
          <button className="close" onClick={onClose} data-hint={t("about.close_hint")}>×</button>
        </div>
        <div className="modal-body" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {error && (
            <div style={{ color: "var(--danger, #c0392b)" }}>{t("about.load_failed", { error })}</div>
          )}
          {info && (
            <>
              <div style={{ marginBottom: 12, flex: "0 0 auto" }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{info.name}</div>
                <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2 }}>
                  {t("about.version_author", { version: info.version, author: info.author })}
                </div>
              </div>

              <div style={{ marginBottom: 12, flex: "0 0 auto" }}>
                <div style={{ fontSize: 12, color: "var(--text-2)", marginBottom: 4 }}>{t("about.description")}</div>
                <div style={{ fontSize: 13, lineHeight: 1.6 }}>{info.description}</div>
              </div>

              <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ fontSize: 12, color: "var(--text-2)", marginBottom: 4, flex: "0 0 auto" }}>
                  {t("about.release_notes")}
                </div>
                <pre
                  style={{
                    fontSize: 12,
                    lineHeight: 1.5,
                    padding: 10,
                    background: "var(--bg-2, #f5f5f5)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    flex: "1 1 auto",
                    minHeight: 0,
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    margin: 0,
                  }}
                >
                  {info.release_notes.trim()}
                </pre>
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={onClose}>{t("about.close")}</button>
        </div>
      </div>
    </div>
  );
}
