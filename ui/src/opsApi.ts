/**
 * Backend client for the ops UI. Vite proxies /api/* to localhost:3000.
 */
import type { ChatResponse, OpsSnapshot, ReasoningTrailItem } from "./opsTypes";

export interface HistoryItem {
  role: "user" | "assistant";
  content: string;
}

async function postChat(
  message: string,
  history: HistoryItem[],
): Promise<ChatResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`);
  }
  return res.json();
}

async function getSnapshot(): Promise<OpsSnapshot> {
  const res = await fetch("/api/ops/snapshot");
  if (!res.ok) throw new Error(`snapshot ${res.status} ${res.statusText}`);
  return res.json();
}

export { postChat, getSnapshot };
export type { ReasoningTrailItem };
