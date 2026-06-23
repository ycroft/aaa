import { useState } from "react";
import type { MessagePart, NodeKind } from "../../../types";
import { detectRichTool, type RichTool } from "./rich-tools";
import { DiffView } from "./DiffView";
import { BashView } from "./BashView";
import { ReadView } from "./ReadView";
import { TodoView } from "./TodoView";
import { Highlight } from "./Highlight";

export function PartView({ part, kind }: { part: MessagePart; kind: NodeKind }) {
  switch (part.kind) {
    case "text": {
      const cls = kind === "assistant" ? "part assistant-text" : "part text";
      return (
        <div className={cls}>
          <div className="label">{kind === "assistant" ? "Assistant" : "Text"}</div>
          <div className="text-body"><Highlight text={part.text} /></div>
        </div>
      );
    }
    case "thinking":
      return (
        <div className="part thinking">
          <div className="label">Thinking</div>
          <div className="text-body"><Highlight text={part.text} /></div>
        </div>
      );
    case "tool_use":
      return <ToolUseView part={part} />;
    case "tool_result":
      return (
        <div className={`part tool_result${part.is_error ? " error" : ""}`}>
          <div className="label">
            Tool Result {part.is_error && <span style={{ color: "var(--error)" }}>错误</span>}
            <span className="tag" style={{ marginLeft: 8 }}>{part.tool_use_id.slice(0, 12)}</span>
          </div>
          <pre className="body"><Highlight text={part.content} /></pre>
        </div>
      );
    case "image":
      return (
        <div className="part note">
          <div className="label">Image</div>
          <div className="text-body">{part.media_type}，{part.bytes} 字节</div>
        </div>
      );
    case "attachment":
      return (
        <div className="part note">
          <div className="label">Attachment</div>
          <div className="text-body"><Highlight text={`${part.path}${part.mime ? ` · ${part.mime}` : ""}`} /></div>
        </div>
      );
    case "note":
      return (
        <div className="part note">
          <div className="label">System</div>
          <div className="text-body"><Highlight text={part.text} /></div>
        </div>
      );
  }
}

const RICH_TOGGLE_LABEL: Record<RichTool["kind"], string> = {
  edit: "查看 Diff",
  bash: "查看命令",
  read: "查看文件",
  todos: "查看待办",
};

function renderRich(rich: RichTool) {
  switch (rich.kind) {
    case "edit": return <DiffView data={rich.data} />;
    case "bash": return <BashView data={rich.data} />;
    case "read": return <ReadView data={rich.data} />;
    case "todos": return <TodoView data={rich.data} />;
  }
}

function ToolUseView({ part }: { part: Extract<MessagePart, { kind: "tool_use" }> }) {
  const output = part.output ?? null;
  const rich = detectRichTool(part.name, part.input, output);
  const [showRaw, setShowRaw] = useState(false);
  const showRich = rich != null && !showRaw;

  return (
    <div className="part tool_use">
      <div className="label">
        Tool Call <span className="name">{part.name}</span>
        <span className="tag" style={{ marginLeft: 8 }}>{part.tool_use_id.slice(0, 12)}</span>
        {rich && (
          <button
            type="button"
            className="rich-toggle"
            onClick={() => setShowRaw((v) => !v)}
            title={showRich ? "切换到原始 JSON" : "切换到富文本视图"}
            aria-pressed={!showRich}
          >
            {showRich ? "原始" : RICH_TOGGLE_LABEL[rich.kind]}
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
