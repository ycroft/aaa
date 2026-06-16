import { useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { ProviderInfo, RemoteHostInfo, RemoteHostInput } from "../types";
import { useT } from "../i18n";
import { providerLabel } from "../format";

interface Props {
  initial: RemoteHostInfo | null;
  providers: ProviderInfo[];
  onCancel: () => void;
  onSave: (input: RemoteHostInput) => Promise<void>;
}

const EMPTY: RemoteHostInput = {
  id: null,
  label: "",
  host: "",
  port: 22,
  user: "",
  auth: { kind: "password", password: "" },
  provider_root_overrides: {},
};

export function RemoteEditor({ initial, providers, onCancel, onSave }: Props) {
  const t = useT();
  const [draft, setDraft] = useState<RemoteHostInput>(() =>
    initial
      ? {
          id: initial.id,
          label: initial.label,
          host: initial.host,
          port: initial.port,
          user: initial.user,
          auth: null,
          provider_root_overrides: { ...initial.provider_root_overrides },
        }
      : { ...EMPTY }
  );
  const [authKind, setAuthKind] = useState<"password" | "private_key">(
    initial?.auth_kind ?? "password",
  );
  const [authTouched, setAuthTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showOverrides, setShowOverrides] = useState(false);

  function patch(p: Partial<RemoteHostInput>) {
    setDraft((d) => ({ ...d, ...p }));
  }

  function ensureAuth(kind: "password" | "private_key") {
    setAuthKind(kind);
    setAuthTouched(true);
    if (kind === "password") {
      patch({ auth: { kind: "password", password: "" } });
    } else {
      patch({ auth: { kind: "private_key", path: "", passphrase: null } });
    }
  }

  async function pickKeyFile() {
    const picked = await openFileDialog({ multiple: false });
    if (typeof picked === "string" && draft.auth?.kind === "private_key") {
      patch({ auth: { ...draft.auth, path: picked } });
    }
  }

  function setOverride(providerId: string, value: string) {
    const map = { ...draft.provider_root_overrides };
    if (value.trim() === "") {
      delete map[providerId];
    } else {
      map[providerId] = value;
    }
    patch({ provider_root_overrides: map });
  }

  function effectiveInput(): RemoteHostInput {
    if (initial && !authTouched) return { ...draft, auth: null };
    return draft;
  }

  return (
    <div className="modal-body">
      <div className="field">
        <label>{t("remote_editor.label")}</label>
        <input
          value={draft.label}
          onChange={(e) => patch({ label: e.target.value })}
          placeholder={t("remote_editor.label_placeholder")}
        />
      </div>
      <div className="field">
        <label>{t("remote_editor.host_port")}</label>
        <div className="row">
          <input
            value={draft.host}
            onChange={(e) => patch({ host: e.target.value })}
            placeholder={t("remote_editor.host_placeholder")}
          />
          <input
            type="number"
            value={draft.port}
            onChange={(e) => patch({ port: Number(e.target.value) || 22 })}
            style={{ maxWidth: 80 }}
          />
        </div>
      </div>
      <div className="field">
        <label>{t("remote_editor.user")}</label>
        <input
          value={draft.user}
          onChange={(e) => patch({ user: e.target.value })}
        />
      </div>
      <div className="field">
        <label>{t("remote_editor.auth")}</label>
        <select value={authKind} onChange={(e) => ensureAuth(e.target.value as any)}>
          <option value="password">{t("remote_editor.auth_password")}</option>
          <option value="private_key">{t("remote_editor.auth_private_key")}</option>
        </select>
      </div>
      {authKind === "password" && (
        <div className="field">
          <label>{t("remote_editor.password")}</label>
          <input
            type="password"
            placeholder={initial && !authTouched ? t("remote_editor.password_unchanged") : ""}
            value={draft.auth?.kind === "password" ? draft.auth.password : ""}
            onChange={(e) => {
              setAuthTouched(true);
              patch({ auth: { kind: "password", password: e.target.value } });
            }}
          />
        </div>
      )}
      {authKind === "private_key" && (
        <>
          <div className="field">
            <label>{t("remote_editor.key_file")}</label>
            <div className="row">
              <input
                value={draft.auth?.kind === "private_key" ? draft.auth.path : ""}
                onChange={(e) => {
                  setAuthTouched(true);
                  patch({
                    auth: {
                      kind: "private_key",
                      path: e.target.value,
                      passphrase:
                        draft.auth?.kind === "private_key" ? draft.auth.passphrase : null,
                    },
                  });
                }}
                placeholder={initial && !authTouched ? t("remote_editor.password_unchanged") : t("remote_editor.key_path_placeholder")}
              />
              <button className="btn" onClick={pickKeyFile}>{t("remote_editor.browse")}</button>
            </div>
          </div>
          <div className="field">
            <label>{t("remote_editor.passphrase")}</label>
            <input
              type="password"
              placeholder={t("remote_editor.passphrase_optional")}
              value={
                draft.auth?.kind === "private_key" ? draft.auth.passphrase ?? "" : ""
              }
              onChange={(e) => {
                setAuthTouched(true);
                if (draft.auth?.kind === "private_key") {
                  patch({
                    auth: {
                      kind: "private_key",
                      path: draft.auth.path,
                      passphrase: e.target.value || null,
                    },
                  });
                }
              }}
            />
          </div>
        </>
      )}

      <div className="field">
        <label>
          <button
            className="btn"
            onClick={() => setShowOverrides((v) => !v)}
          >
            {showOverrides ? t("remote_editor.overrides_expanded") : t("remote_editor.overrides_collapsed")}
          </button>
        </label>
      </div>
      {showOverrides && providers.map((p) => (
        <div className="field" key={p.id}>
          <label style={{ paddingLeft: 16 }}>{providerLabel(p, t)}</label>
          <input
            value={draft.provider_root_overrides[p.id] ?? ""}
            onChange={(e) => setOverride(p.id, e.target.value)}
            placeholder={t("remote_editor.overrides_auto")}
          />
        </div>
      ))}

      <div className="modal-foot">
        <button className="btn" onClick={onCancel}>{t("remote_editor.cancel")}</button>
        <button
          className="btn primary"
          disabled={busy || !draft.host || !draft.user || !draft.label}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(effectiveInput());
            } finally {
              setBusy(false);
            }
          }}
        >{t("remote_editor.save")}</button>
      </div>
    </div>
  );
}
