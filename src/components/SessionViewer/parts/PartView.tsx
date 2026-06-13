import { useState } from "react";
import { useT } from "../../../i18n";
import type { MessagePart, NodeKind } from "../../../types";
import { detectFileEdit } from "./edit-detect";
import { DiffView } from "./DiffView";

export function PartView({ part, kind }: { part: MessagePart; kind: NodeKind }) {
  const t = useT();
  switch (part.kind) {
    case "text": {
      const cls = kind === "assistant" ? "part assistant-text" : "part text";
      return (
        <div className={cls}>
          <div className="label">{kind === "assistant" ? t("viewer.parts.assistant") : t("viewer.parts.text")}</div>
          <div className="text-body">{part.text}</div>
        </div>
      );
    }
    case "thinking":
      return (
        <div className="part thinking">
          <div className="label">{t("viewer.parts.thinking")}</div>
          <div className="text-body">{part.text}</div>
        </div>
      );
    case "tool_use":
      return <ToolUseView part={part} />;
    case "tool_result":
      return (
        <div className={`part tool_result${part.is_error ? " error" : ""}`}>
          <div className="label">
            {t("viewer.parts.tool_result")} {part.is_error && <span style={{ color: "var(--error)" }}>{t("viewer.parts.tool_error")}</span>}
            <span className="tag" style={{ marginLeft: 8 }}>{part.tool_use_id.slice(0, 12)}</span>
          </div>
          <pre className="body">{part.content}</pre>
        </div>
      );
    case "image":
      return (
        <div className="part note">
          <div className="label">{t("viewer.parts.image")}</div>
          <div className="text-body">{t("viewer.parts.image_size", { type: part.media_type, bytes: part.bytes })}</div>
        </div>
      );
    case "attachment":
      return (
        <div className="part note">
          <div className="label">{t("viewer.parts.attachment")}</div>
          <div className="text-body">{part.path}{part.mime ? ` · ${part.mime}` : ""}</div>
        </div>
      );
    case "note":
      return (
        <div className="part note">
          <div className="label">{t("viewer.parts.system")}</div>
          <div className="text-body">{part.text}</div>
        </div>
      );
  }
}

function ToolUseView({ part }: { part: Extract<MessagePart, { kind: "tool_use" }> }) {
  const t = useT();
  const fileEdit = detectFileEdit(part.name, part.input);
  const [showRaw, setShowRaw] = useState(false);
  const canDiff = fileEdit != null;
  const renderDiff = canDiff && !showRaw;

  return (
    <div className="part tool_use">
      <div className="label">
        {t("viewer.parts.tool_call")} <span className="name">{part.name}</span>
        <span className="tag" style={{ marginLeft: 8 }}>{part.tool_use_id.slice(0, 12)}</span>
        {canDiff && (
          <button
            type="button"
            className="diff-toggle"
            onClick={() => setShowRaw((v) => !v)}
            title={renderDiff ? t("viewer.diff.toggle_to_raw_hint") : t("viewer.diff.toggle_to_diff_hint")}
            aria-pressed={!renderDiff}
          >
            {renderDiff ? t("viewer.diff.toggle_to_raw") : t("viewer.diff.toggle_to_diff")}
          </button>
        )}
      </div>
      {renderDiff && fileEdit ? (
        <DiffView data={fileEdit} />
      ) : (
        <pre className="body">{part.input}</pre>
      )}
    </div>
  );
}
