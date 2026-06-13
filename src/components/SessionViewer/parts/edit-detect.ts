// Detect file-modification tool calls and normalize their JSON input into a
// shape the diff renderer can consume. Both claude-code and opencode store
// the tool_use payload as a pretty-printed JSON string in `MessagePart.input`;
// opencode additionally appends a "--- output ---" trailer with the tool's
// stdout, which we strip before parsing.

export type NormalizedEdit =
  | { kind: "replace"; oldText: string; newText: string; replaceAll: boolean }
  | { kind: "write"; newText: string }
  | { kind: "delete"; oldText: string };

export interface NormalizedFileEdit {
  filePath: string;
  /** "edit" / "write" / "multi_edit" / "notebook_edit" */
  variant: string;
  edits: NormalizedEdit[];
}

const CLAUDE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// opencode tool names are lowercase; we accept a few common variants.
const OPENCODE_TOOLS = new Set(["edit", "write", "multiedit", "patch"]);

export function isFileEditTool(name: string): boolean {
  return CLAUDE_TOOLS.has(name) || OPENCODE_TOOLS.has(name.toLowerCase());
}

/**
 * Strip opencode's "--- output ---" trailer and parse the JSON head.
 * Returns null on malformed input rather than throwing — the caller should
 * fall back to raw display.
 */
function parseInputJson(input: string): unknown | null {
  const marker = "\n\n--- output ---\n";
  const head = input.includes(marker) ? input.slice(0, input.indexOf(marker)) : input;
  const trimmed = head.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  return null;
}

function pickBool(obj: Record<string, unknown>, ...keys: string[]): boolean {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "boolean") return v;
  }
  return false;
}

export function detectFileEdit(name: string, input: string): NormalizedFileEdit | null {
  if (!isFileEditTool(name)) return null;
  const parsed = parseInputJson(input);
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const lower = name.toLowerCase();

  // ---------- single Edit (claude-code & opencode) ----------
  if (lower === "edit") {
    const filePath = pickString(obj, "file_path", "filePath", "path");
    const oldText = pickString(obj, "old_string", "oldString");
    const newText = pickString(obj, "new_string", "newString");
    if (filePath == null || oldText == null || newText == null) return null;
    return {
      filePath,
      variant: "edit",
      edits: [
        {
          kind: "replace",
          oldText,
          newText,
          replaceAll: pickBool(obj, "replace_all", "replaceAll"),
        },
      ],
    };
  }

  // ---------- Write (full-file write) ----------
  if (lower === "write") {
    const filePath = pickString(obj, "file_path", "filePath", "path");
    const content = pickString(obj, "content", "newString", "new_string");
    if (filePath == null || content == null) return null;
    return {
      filePath,
      variant: "write",
      edits: [{ kind: "write", newText: content }],
    };
  }

  // ---------- MultiEdit (claude-code & opencode "multiedit") ----------
  if (lower === "multiedit") {
    const filePath = pickString(obj, "file_path", "filePath", "path");
    const editsRaw = obj["edits"];
    if (filePath == null || !Array.isArray(editsRaw)) return null;
    const edits: NormalizedEdit[] = [];
    for (const raw of editsRaw) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const oldText = pickString(e, "old_string", "oldString");
      const newText = pickString(e, "new_string", "newString");
      if (oldText == null || newText == null) continue;
      edits.push({
        kind: "replace",
        oldText,
        newText,
        replaceAll: pickBool(e, "replace_all", "replaceAll"),
      });
    }
    if (edits.length === 0) return null;
    return { filePath, variant: "multi_edit", edits };
  }

  // ---------- NotebookEdit (claude-code) ----------
  if (lower === "notebookedit") {
    const filePath = pickString(obj, "notebook_path", "notebookPath", "file_path", "filePath");
    const newSource = pickString(obj, "new_source", "newSource");
    const editMode = pickString(obj, "edit_mode", "editMode") ?? "replace";
    if (filePath == null) return null;
    if (editMode === "delete") {
      return {
        filePath,
        variant: "notebook_edit",
        edits: [{ kind: "delete", oldText: newSource ?? "" }],
      };
    }
    if (newSource == null) return null;
    return {
      filePath,
      variant: "notebook_edit",
      edits: [{ kind: "write", newText: newSource }],
    };
  }

  // ---------- opencode "patch" (rare) — fall back to no diff ----------
  return null;
}
