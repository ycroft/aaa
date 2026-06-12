import { useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { ProviderInfo, RemoteHostInfo, RemoteHostInput } from "../types";

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
        <label>Label</label>
        <input
          value={draft.label}
          onChange={(e) => patch({ label: e.target.value })}
          placeholder="work-server"
        />
      </div>
      <div className="field">
        <label>Host / Port</label>
        <div className="row">
          <input
            value={draft.host}
            onChange={(e) => patch({ host: e.target.value })}
            placeholder="10.0.0.5"
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
        <label>User</label>
        <input
          value={draft.user}
          onChange={(e) => patch({ user: e.target.value })}
          placeholder="root"
        />
      </div>
      <div className="field">
        <label>Auth</label>
        <select value={authKind} onChange={(e) => ensureAuth(e.target.value as any)}>
          <option value="password">Password</option>
          <option value="private_key">Private key</option>
        </select>
      </div>
      {authKind === "password" && (
        <div className="field">
          <label>Password</label>
          <input
            type="password"
            placeholder={initial && !authTouched ? "(unchanged)" : ""}
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
            <label>Key file</label>
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
                placeholder={initial && !authTouched ? "(unchanged)" : "/path/to/id_ed25519"}
              />
              <button className="btn" onClick={pickKeyFile}>Browse…</button>
            </div>
          </div>
          <div className="field">
            <label>Passphrase</label>
            <input
              type="password"
              placeholder="(optional)"
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
            {showOverrides ? "▾" : "▸"} Provider root overrides
          </button>
        </label>
      </div>
      {showOverrides && providers.map((p) => (
        <div className="field" key={p.id}>
          <label style={{ paddingLeft: 16 }}>{p.display_name}</label>
          <input
            value={draft.provider_root_overrides[p.id] ?? ""}
            onChange={(e) => setOverride(p.id, e.target.value)}
            placeholder="(auto-detect)"
          />
        </div>
      ))}

      <div className="modal-foot">
        <button className="btn" onClick={onCancel}>Cancel</button>
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
        >Save</button>
      </div>
    </div>
  );
}
