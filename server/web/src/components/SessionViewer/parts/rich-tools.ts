import { detectFileEdit, type NormalizedFileEdit } from "./edit-detect";

interface ParsedArgs {
  args: Record<string, unknown> | null;
}

function parseArgs(input: string): ParsedArgs {
  let args: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(input.trim());
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch { /* ignore */ }
  return { args };
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

export interface BashCall {
  command: string;
  description: string | null;
  timeout: number | null;
  runInBackground: boolean;
  output: string | null;
}

function detectBash(name: string, input: string, output: string | null): BashCall | null {
  if (name.toLowerCase() !== "bash") return null;
  const { args } = parseArgs(input);
  if (!args) return null;
  const command = pickStr(args, "command", "cmd");
  if (command == null) return null;
  return { command, description: pickStr(args, "description"), timeout: pickNum(args, "timeout"), runInBackground: pickBool(args, "run_in_background", "runInBackground"), output };
}

export interface ReadCall {
  filePath: string;
  offset: number | null;
  limit: number | null;
  output: string | null;
}

function detectRead(name: string, input: string, output: string | null): ReadCall | null {
  if (name.toLowerCase() !== "read") return null;
  const { args } = parseArgs(input);
  if (!args) return null;
  const filePath = pickStr(args, "file_path", "filePath", "path");
  if (filePath == null) return null;
  return { filePath, offset: pickNum(args, "offset"), limit: pickNum(args, "limit"), output };
}

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
  if (name.toLowerCase() !== "todowrite") return null;
  const { args } = parseArgs(input);
  if (!args || !Array.isArray(args["todos"])) return null;
  const todos: TodoItem[] = [];
  for (const raw of args["todos"] as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const content = pickStr(obj, "content", "subject", "description");
    if (content == null) continue;
    todos.push({ content, activeForm: pickStr(obj, "activeForm", "active_form"), status: (pickStr(obj, "status") ?? "pending") as TodoStatus });
  }
  if (todos.length === 0) return null;
  return { todos };
}

export type RichTool =
  | { kind: "edit"; data: NormalizedFileEdit }
  | { kind: "bash"; data: BashCall }
  | { kind: "read"; data: ReadCall }
  | { kind: "todos"; data: TodoList };

export function detectRichTool(name: string, input: string, output: string | null): RichTool | null {
  const edit = detectFileEdit(name, input);
  if (edit) return { kind: "edit", data: edit };
  const bash = detectBash(name, input, output);
  if (bash) return { kind: "bash", data: bash };
  const read = detectRead(name, input, output);
  if (read) return { kind: "read", data: read };
  const todos = detectTodos(name, input);
  if (todos) return { kind: "todos", data: todos };
  return null;
}
