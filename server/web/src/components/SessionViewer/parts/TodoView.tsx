import { useMemo } from "react";
import type { TodoList, TodoStatus } from "./rich-tools";
import { Highlight } from "./Highlight";

const KNOWN: TodoStatus[] = ["pending", "in_progress", "completed"];

function statusKey(raw: string): TodoStatus {
  return (KNOWN as string[]).includes(raw) ? (raw as TodoStatus) : "pending";
}

const MARKER: Record<TodoStatus, string> = {
  pending: "○",
  in_progress: "▶",
  completed: "✓",
};

export function TodoView({ data }: { data: TodoList }) {
  const counts = useMemo(() => {
    const c = { pending: 0, in_progress: 0, completed: 0 };
    for (const todo of data.todos) {
      const k = statusKey(todo.status);
      c[k] += 1;
    }
    return c;
  }, [data]);

  return (
    <div className="rich-view todos-view">
      <div className="rich-header">
        <span className="rich-variant">TodoWrite</span>
        <span className="rich-spacer" />
        <span className="rich-tag todos-stat-pending">待办 {counts.pending}</span>
        <span className="rich-tag todos-stat-progress">进行中 {counts.in_progress}</span>
        <span className="rich-tag todos-stat-done">已完成 {counts.completed}</span>
      </div>
      <ul className="todos-list">
        {data.todos.map((todo, i) => {
          const s = statusKey(todo.status);
          const text = s === "in_progress" && todo.activeForm ? todo.activeForm : todo.content;
          return (
            <li key={i} className={`todos-row todos-row-${s}`}>
              <span className="todos-marker" aria-hidden="true">{MARKER[s]}</span>
              <span className="todos-text"><Highlight text={text} /></span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
