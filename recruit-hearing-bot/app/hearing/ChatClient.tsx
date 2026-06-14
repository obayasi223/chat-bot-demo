"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Msg = {
  id: string;
  role: "user" | "bot";
  text: string;
};

type Meta = {
  flowId: string | null;
  mode: "idle" | "collecting" | "done";
  currentKey: string | null;
  pendingKey: string | null;
  answeredCount: number;
  totalSlots: number;
  inFollowup: boolean;
};

type Progress = {
  answered: number;
  total: number;
  inFollowup: boolean;
  mode: Meta["mode"];
};

const RESET_COMMAND = "__reset__";

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// エラー表示文を組み立てる（メッセージ＋エラーコード＋追跡ID）
function formatError(
  message: string,
  code?: string,
  requestId?: string
): string {
  const parts: string[] = [];
  if (code) parts.push(`エラーコード: ${code}`);
  if (requestId) parts.push(`ID: ${requestId}`);
  return parts.length > 0 ? `${message}（${parts.join(" / ")}）` : message;
}

// エラーレスポンス(JSON)を読み取り、表示用の文言にする
async function readErrorResponse(res: Response): Promise<string> {
  const requestIdHeader = res.headers.get("x-request-id") ?? undefined;
  try {
    const data = await res.json();
    const err = data?.error;
    if (err) {
      return formatError(
        String(err.message ?? "エラーが発生しました"),
        err.code,
        err.requestId ?? requestIdHeader
      );
    }
  } catch {
    // JSONでない場合はステータスで代替
  }
  return formatError(
    "エラーが発生しました。時間をおいて再度お試しください。",
    `HTTP_${res.status}`,
    requestIdHeader
  );
}

export default function ChatClient() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [mode, setMode] = useState<Meta["mode"]>("idle");
  const [progress, setProgress] = useState<Progress>({
    answered: 0,
    total: 0,
    inFollowup: false,
    mode: "idle",
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sendLockRef = useRef(false);

  // 末尾へ自動スクロール
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // サーバの meta をモード・進捗へ反映
  const applyMeta = useCallback((meta: any) => {
    if (!meta) return;
    if (meta.mode) setMode(meta.mode);
    setProgress({
      answered: Number(meta.answeredCount ?? 0),
      total: Number(meta.totalSlots ?? 0),
      inFollowup: !!meta.inFollowup,
      mode: meta.mode ?? "idle",
    });
  }, []);

  // 初期化：状態を読み込み（未開始ならサーバ側で開始され最初の質問が返る）
  const loadState = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/hearing", { cache: "no-store" });
      if (!res.ok) throw new Error(await readErrorResponse(res));
      const data = await res.json();
      const raw = Array.isArray(data?.messages) ? data.messages : [];
      const mapped: Msg[] = raw.map((m: any) => ({
        id: String(m.id ?? uid()),
        role: m.role === "user" ? "user" : "bot",
        text: String(m.content ?? ""),
      }));
      setMessages(mapped);
      applyMeta(data?.meta);
    } catch (e: any) {
      setWarning(e?.message ?? "読み込みに失敗しました。ページを再読み込みしてください");
    } finally {
      setBusy(false);
    }
  }, [applyMeta]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  const send = useCallback(
    async (text: string, displayText?: string) => {
      const t = String(text ?? "").trim();
      if (!t) return;
      if (sendLockRef.current) return;
      sendLockRef.current = true;

      setWarning(null);
      setBusy(true);

      const isReset = t === RESET_COMMAND;
      // 画面にユーザー発話を即時反映
      setMessages((prev) => [
        ...prev,
        { id: uid(), role: "user", text: displayText ?? t },
      ]);
      setInput("");

      // 逐次表示用の bot プレースホルダを用意
      const botId = uid();
      if (isReset) {
        setMessages([{ id: botId, role: "bot", text: "" }]);
      } else {
        setMessages((prev) => [...prev, { id: botId, role: "bot", text: "" }]);
      }

      let acc = "";
      const setBotText = (text: string) =>
        setMessages((prev) =>
          prev.map((m) => (m.id === botId ? { ...m, text } : m))
        );

      try {
        const res = await fetch("/api/hearing", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: t }),
        });
        if (!res.ok || !res.body) throw new Error(await readErrorResponse(res));

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalMeta: any = null;

        // SSE（data: {json}\n\n）を逐次パース
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;

            let evt: any;
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }

            if (evt.type === "delta") {
              acc += String(evt.text ?? "");
              setBotText(acc);
            } else if (evt.type === "done") {
              if (typeof evt.outText === "string" && evt.outText !== acc) {
                acc = evt.outText;
                setBotText(acc);
              }
              if (evt?.meta) finalMeta = evt.meta;
            } else if (evt.type === "error") {
              throw new Error(
                formatError(
                  String(evt.message ?? "送信できませんでした"),
                  evt.code,
                  evt.requestId
                )
              );
            }
          }
        }

        if (finalMeta) applyMeta(finalMeta);
      } catch (e: any) {
        // 失敗時はプレースホルダを除去して警告
        setMessages((prev) => prev.filter((m) => m.id !== botId || m.text));
        setWarning(e?.message ?? "送信できませんでした。しばらくしてからお試しください");
      } finally {
        setBusy(false);
        sendLockRef.current = false;
      }
    },
    [applyMeta]
  );

  const canSend = !busy && input.trim().length > 0;
  const isDone = mode === "done";

  // 進捗率（0〜100）。完了なら100%。
  const pct =
    progress.mode === "done"
      ? 100
      : progress.total > 0
      ? Math.round((progress.answered / progress.total) * 100)
      : 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        height: "100%",
        minHeight: 0,
        background: "#fff",
        color: "#111",
        border: "1px solid #e5e7eb",
        borderRadius: 14,
        padding: 12,
      }}
    >
      {/* 進捗バー（全体の進行度） */}
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 6,
            fontSize: 12,
            color: "#6b7280",
          }}
        >
          <span style={{ fontWeight: 700, color: "#374151" }}>
            {isDone
              ? "ご入力完了"
              : progress.total > 0
              ? `質問 ${Math.min(progress.answered + 1, progress.total)} / ${progress.total}`
              : "読み込み中…"}
            {progress.inFollowup && !isDone && (
              <span
                style={{
                  marginLeft: 8,
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "#eef2ff",
                  color: "#4338ca",
                  border: "1px solid #c7d2fe",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                追加のご質問
              </span>
            )}
          </span>
          <span>{pct}%</span>
        </div>
        <div
          style={{
            height: 8,
            width: "100%",
            background: "#eef0f3",
            borderRadius: 999,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${pct}%`,
              background: isDone ? "#16a34a" : "#111",
              borderRadius: 999,
              transition: "width 320ms ease",
            }}
          />
        </div>
        {progress.inFollowup && !isDone && (
          <div style={{ marginTop: 4, fontSize: 11, color: "#9ca3af" }}>
            ※ ご回答内容に応じて、追加のご質問をさせていただく場合がございます
          </div>
        )}
      </div>

      {warning && (
        <div
          style={{
            padding: 10,
            border: "1px solid #fca5a5",
            borderRadius: 10,
            background: "#fef2f2",
            fontSize: 13,
          }}
        >
          {warning}
        </div>
      )}

      {/* メッセージ一覧 */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          paddingRight: 4,
        }}
      >
        {messages.map((m) =>
          m.role === "bot" && m.text === "" ? null : (
          <div
            key={m.id}
            style={{
              margin: "10px 0",
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div
              style={{
                maxWidth: "80%",
                padding: "10px 12px",
                borderRadius: 14,
                border: "1px solid #e5e7eb",
                background: m.role === "user" ? "#111" : "#f9fafb",
                color: m.role === "user" ? "#fff" : "#111",
                whiteSpace: "pre-wrap",
                lineHeight: 1.6,
                fontSize: 14,
              }}
            >
              {m.text}
            </div>
          </div>
          )
        )}
        {busy && <div style={{ color: "#9ca3af", fontSize: 13 }}>回答を作成しています…</div>}
      </div>

      {/* 入力エリア */}
      <div
        style={{
          borderTop: "1px solid #eee",
          paddingTop: 10,
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (canSend) send(input);
              }
            }}
            placeholder={
              isDone
                ? "ご入力は完了しています"
                : "ご回答を入力してください（Enterで送信 / Shift+Enterで改行）"
            }
            disabled={busy || isDone}
            rows={2}
            style={{
              flex: 1,
              resize: "none",
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid #ddd",
              background: isDone ? "#f3f4f6" : "#fff",
              color: "#111",
              fontSize: 14,
              lineHeight: 1.5,
              fontFamily: "inherit",
            }}
          />
          <button
            onClick={() => canSend && send(input)}
            disabled={!canSend}
            style={{
              padding: "10px 16px",
              borderRadius: 12,
              border: "1px solid #111",
              background: canSend ? "#111" : "#e5e7eb",
              color: canSend ? "#fff" : "#9ca3af",
              cursor: canSend ? "pointer" : "default",
              fontWeight: 700,
              whiteSpace: "nowrap",
            }}
          >
            送信
          </button>
        </div>

        <div style={{ marginTop: 8, display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={() => {
              if (busy) return;
              if (window.confirm("入力内容をすべて削除し、最初からやり直しますか？")) {
                send(RESET_COMMAND, "最初から入力し直す");
              }
            }}
            disabled={busy}
            style={{
              padding: "6px 12px",
              borderRadius: 10,
              border: "1px solid #ccc",
              background: "#f9fafb",
              color: "#374151",
              cursor: busy ? "default" : "pointer",
              fontSize: 13,
            }}
          >
            最初から入力し直す
          </button>
        </div>
      </div>
    </div>
  );
}
