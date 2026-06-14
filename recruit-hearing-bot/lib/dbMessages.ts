// lib/dbMessages.ts
// チャットログ(messages)の読み書き。実体は lib/store.ts に委譲。
import { getStore, type StoredMessage } from "./store";
import type { Role } from "./state";

export type ChatMessage = StoredMessage;

export async function appendMessage(
  sessionId: string,
  role: Role,
  content: string
): Promise<void> {
  return getStore().appendMessage(sessionId, role, content);
}

export async function getMessages(
  sessionId: string,
  limit = 200
): Promise<ChatMessage[]> {
  return getStore().getMessages(sessionId, limit);
}
