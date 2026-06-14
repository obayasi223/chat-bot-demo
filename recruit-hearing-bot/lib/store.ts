// lib/store.ts
// 永続化レイヤ。Supabase が設定されていればそれを使い、無ければ「インメモリ（仮）」に
// 自動フォールバックする。これにより Supabase 無しでもアプリ全体が確実に動く。
//
// - 本番でちゃんと保存したい場合：NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定
// - デモ/開発：未設定でOK（プロセス内メモリに保持。サーバ再起動で消える＝「仮」）
import crypto from "crypto";
import { blankState, type Role, type State } from "./state";
import { createSupabaseAdminClient } from "./supabase/admin";

export type StoredMessage = {
  id: string;
  role: Role;
  content: string;
  createdAt: string; // ISO
};

export interface Store {
  readonly kind: "supabase" | "memory";
  loadState(sessionId: string): Promise<State>;
  saveState(sessionId: string, state: State): Promise<void>;
  appendMessage(sessionId: string, role: Role, content: string): Promise<void>;
  getMessages(sessionId: string, limit?: number): Promise<StoredMessage[]>;
}

function isSupabaseConfigured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// =========================
// In-memory store（仮）
// HMR / モジュール再評価でも消えないよう globalThis に保持する
// =========================
type MemDB = {
  states: Map<string, State>;
  messages: Map<string, StoredMessage[]>;
};

function getMemDB(): MemDB {
  const g = globalThis as any;
  if (!g.__rhb_memdb) {
    g.__rhb_memdb = {
      states: new Map<string, State>(),
      messages: new Map<string, StoredMessage[]>(),
    } satisfies MemDB;
  }
  return g.__rhb_memdb as MemDB;
}

function createMemoryStore(): Store {
  const db = getMemDB();
  return {
    kind: "memory",
    async loadState(sessionId) {
      const s = db.states.get(sessionId);
      if (!s) return blankState();
      // DB同様、ロードのたびに独立コピーを返す（外部変更で内部が壊れないように）
      return { ...blankState(), ...deepClone(s) };
    },
    async saveState(sessionId, state) {
      db.states.set(sessionId, deepClone(state));
    },
    async appendMessage(sessionId, role, content) {
      const t = String(content ?? "").trim();
      if (!t) return;
      const arr = db.messages.get(sessionId) ?? [];
      arr.push({
        id: crypto.randomUUID(),
        role,
        content: t,
        createdAt: new Date().toISOString(),
      });
      db.messages.set(sessionId, arr);
    },
    async getMessages(sessionId, limit = 200) {
      const arr = db.messages.get(sessionId) ?? [];
      return deepClone(arr.slice(-limit));
    },
  };
}

// =========================
// Supabase store
// =========================
function createSupabaseStore(): Store {
  // createSupabaseAdminClient() は呼び出し時にのみ env を要求する（import時は副作用なし）
  return {
    kind: "supabase",
    async loadState(sessionId) {
      const sb = createSupabaseAdminClient();
      const { data, error } = await sb
        .from("conversations")
        .select("state")
        .eq("session_id", sessionId)
        .maybeSingle();
      if (error) throw error;
      if (!data?.state) return blankState();
      return { ...blankState(), ...(data.state as State) };
    },
    async saveState(sessionId, state) {
      const sb = createSupabaseAdminClient();
      const { error } = await sb.from("conversations").upsert(
        {
          session_id: sessionId,
          state,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "session_id" }
      );
      if (error) throw error;
    },
    async appendMessage(sessionId, role, content) {
      const t = String(content ?? "").trim();
      if (!t) return;
      const sb = createSupabaseAdminClient();
      const { error } = await sb
        .from("messages")
        .insert({ session_id: sessionId, role, content: t });
      if (error) throw error;
    },
    async getMessages(sessionId, limit = 200) {
      const sb = createSupabaseAdminClient();
      const { data, error } = await sb
        .from("messages")
        .select("id, role, content, created_at")
        .eq("session_id", sessionId)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw error;
      return (data ?? []).map((m: any) => ({
        id: String(m.id),
        role: m.role === "user" ? "user" : "bot",
        content: String(m.content ?? ""),
        createdAt: String(m.created_at ?? ""),
      }));
    },
  };
}

// =========================
// シングルトン選択
// =========================
let _store: Store | null = null;

export function getStore(): Store {
  if (_store) return _store;
  if (isSupabaseConfigured()) {
    _store = createSupabaseStore();
    console.info("[store] using Supabase persistence");
  } else {
    _store = createMemoryStore();
    console.warn(
      "[store] Supabase env not set → using IN-MEMORY persistence (仮). " +
        "Data resets on server restart. Set NEXT_PUBLIC_SUPABASE_URL & SUPABASE_SERVICE_ROLE_KEY to persist."
    );
  }
  return _store;
}
