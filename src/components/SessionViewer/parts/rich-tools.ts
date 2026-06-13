// Rich-tool detection: claude-code & opencode tool_use payloads that we render
// with bespoke UI instead of raw JSON. The `edit` variant is the diff renderer
// from `edit-detect.ts`; the others (bash / read / todos) are added here.
//
// Both providers serialize the tool input as pretty JSON, and opencode appends
// a "\n\n--- output ---\n<stdout>" trailer (see opencode.rs::combine_tool).
// We strip the trailer here so detectors see only the JSON head, but expose
// the output text alongside so rich views can render it inline.

import { detectFileEdit, type NormalizedFileEdit } from "./edit-detect";

const OUTPUT_SEP = "\n\n--- output ---\n";

interface ParsedPayload {
  args: Record<string, unknown> | null;
  output: string | null;
}

function parsePayload(input: string): ParsedPayload {
  const idx = input.indexOf(OUTPUT_SEP);
  const head = idx >= 0 ? input.slice(0, idx) : input;
  const tail = idx >= 0 ? input.slice(idx + OUTPUT_SEP.length) : null;
  let args: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(head.trim());
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  return { args, output: tail };
}

function pickStr(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") return v;
  }
  return null;
}

function pickNum(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
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

// ---------- Bash ----------

export interface BashCall {
  command: string;
  description: string | null;
  timeout: number | null;
  runInBackground: boolean;
  output: string | null;
}

function detectBash(name: string, input: string): BashCall | null {
  const lname = name.toLowerCase();
  if (lname !== "bash") return null;
  const { args, output } = parsePayload(input);
  if (!args) return null;
  const command = pickStr(args, "command", "cmd");
  if (command == null) return null;
  return {
    command,
    description: pickStr(args, "description"),
    timeout: pickNum(args, "timeout"),
    runInBackground: pickBool(args, "run_in_background", "runInBackground"),
    output,
  };
}

// ---------- Read ----------

export interface ReadCall {
  filePath: string;
  offset: number | null;
  limit: number | null;
  /** Inlined output (opencode); claude-code emits this as a separate ToolResult. */
  output: string | null;
}

function detectRead(name: string, input: string): ReadCall | null {
  const lname = name.toLowerCase();
  if (lname !== "read") return null;
  const { args, output } = parsePayload(input);
  if (!args) return null;
  const filePath = pickStr(args, "file_path", "filePath", "path");
  if (filePath == null) return null;
  return {
    filePath,
    offset: pickNum(args, "offset"),
    limit: pickNum(args, "limit"),
    output,
  };
}

// ---------- TodoWrite ----------

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  activeForm: string | null;
  status: TodoStatus | string;
}

export interface TodoList {
  todos: TodoItem[];
}

function detectTodos(name: string, input: string): TodoList | null {
  const lname = name.toLowerCase();
  if (lname !== "todowrite") return null;
  const { args } = parsePayload(input);
  if (!args || !Array.isArray(args["todos"])) return null;
  const todos: TodoItem[] = [];
  for (const raw of args["todos"] as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const content = pickStr(obj, "content", "subject", "description");
    if (content == null) continue;
    todos.push({
      content,
      activeForm: pickStr(obj, "activeForm", "active_form"),
      status: (pickStr(obj, "status") ?? "pending") as TodoStatus,
    });
  }
  if (todos.length === 0) return null;
  return { todos };
}

// ---------- Dispatcher ----------

export type RichTool =
  | { kind: "edit"; data: NormalizedFileEdit }
  | { kind: "bash"; data: BashCall }
  | { kind: "read"; data: ReadCall }
  | { kind: "todos"; data: TodoList };

export function detectRichTool(name: string, input: string): RichTool | null {
  const edit = detectFileEdit(name, input);
  if (edit) return { kind: "edit", data: edit };
  const bash = detectBash(name, input);
  if (bash) return { kind: "bash", data: bash };
  const read = detectRead(name, input);
  if (read) return { kind: "read", data: read };
  const todos = detectTodos(name, input);
  if (todos) return { kind: "todos", data: todos };
  return null;
}
