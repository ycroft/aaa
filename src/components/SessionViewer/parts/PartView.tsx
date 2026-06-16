import { useState } from "react";
import { useT, type TKey } from "../../../i18n";
import type { MessagePart, NodeKind } from "../../../types";
import { detectRichTool, type RichTool } from "./rich-tools";
import { DiffView } from "./DiffView";
import { BashView } from "./BashView";
import { ReadView } from "./ReadView";
import { TodoView } from "./TodoView";
import { Highlight } from "./Highlight";

export function PartView({ part, kind }: { part: MessagePart; kind: NodeKind }) {
  const t = useT();
  switch (part.kind) {
    case "text": {
      const cls = kind === "assistant" ? "part assistant-text" : "part text";
      return (
        <div className={cls}>
          <div className="label">{kind === "assistant" ? t("viewer.parts.assistant") : t("viewer.parts.text")}</div>
          <div className="text-body"><Highlight text={part.text} /></div>
        </div>
      );
    }
    case "thinking":
      return (
        <div className="part thinking">
          <div className="label">{t("viewer.parts.thinking")}</div>
          <div className="text-body"><Highlight text={part.text} /></div>
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
          <pre className="body"><Highlight text={part.content} /></pre>
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
          <div className="text-body"><Highlight text={`${part.path}${part.mime ? ` · ${part.mime}` : ""}`} /></div>
        </div>
      );
    case "note":
      return (
        <div className="part note">
          <div className="label">{t("viewer.parts.system")}</div>
          <div className="text-body"><Highlight text={part.text} /></div>
        </div>
      );
  }
}

const RICH_TOGGLE_KEY: Record<RichTool["kind"], TKey> = {
  edit: "viewer.rich.toggle_to_diff",
  bash: "viewer.rich.toggle_to_bash",
  read: "viewer.rich.toggle_to_read",
  todos: "viewer.rich.toggle_to_todos",
};

function renderRich(rich: RichTool) {
  switch (rich.kind) {
    case "edit":
      return <DiffView data={rich.data} />;
    case "bash":
      return <BashView data={rich.data} />;
    case "read":
      return <ReadView data={rich.data} />;
    case "todos":
      return <TodoView data={rich.data} />;
  }
}

function ToolUseView({ part }: { part: Extract<MessagePart, { kind: "tool_use" }> }) {
  const t = useT();
  const output = part.output ?? null;
  const rich = detectRichTool(part.name, part.input, output);
  const [showRaw, setShowRaw] = useState(false);
  const showRich = rich != null && !showRaw;

  return (
    <div className="part tool_use">
      <div className="label">
        {t("viewer.parts.tool_call")} <span className="name">{part.name}</span>
        <span className="tag" style={{ marginLeft: 8 }}>{part.tool_use_id.slice(0, 12)}</span>
        {rich && (
          <button
            type="button"
            className="rich-toggle"
            onClick={() => setShowRaw((v) => !v)}
            title={showRich ? t("viewer.rich.toggle_to_raw_hint") : t("viewer.rich.toggle_to_view_hint")}
            aria-pressed={!showRich}
          >
            {showRich ? t("viewer.rich.toggle_to_raw") : t(RICH_TOGGLE_KEY[rich.kind])}
          </button>
        )}
      </div>
      {showRich && rich ? (
        renderRich(rich)
      ) : (
        <>
          <pre className="body"><Highlight text={part.input} /></pre>
          {output != null && (
            <pre className="body tool-output"><Highlight text={output} /></pre>
          )}
        </>
      )}
    </div>
  );
}
