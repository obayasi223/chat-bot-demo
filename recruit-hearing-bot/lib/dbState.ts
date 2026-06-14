// lib/dbState.ts
// 会話状態(State)の読み書き。実体は lib/store.ts（Supabase or インメモリ）に委譲。
import { getStore } from "./store";
import type { State } from "./state";

export async function loadState(sessionId: string): Promise<State> {
  return getStore().loadState(sessionId);
}

export async function saveState(sessionId: string, state: State): Promise<void> {
  return getStore().saveState(sessionId, state);
}
