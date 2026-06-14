"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Msg = {
  id: string;
  role: "user" | "bot";
  text: string;
};

type AxisScore = {
  id: string;
  label: string;
  score: number;
  answered: boolean;
};

type Coverage = {
  axes: AxisScore[];
  coverage: number;
  evenness: number;
  balance: number;
  min: number;
  max: number;
  weakestAxisId: string | null;
  gaps: string[];
  balanced: boolean;
};

type Meta = {
  flowId: string | null;
  mode: "idle" | "collecting" | "done";
  currentKey: string | null;
  pendingKey: string | null;
  answeredCount: number;
  totalSlots: number;
  inFollowup: boolean;
  coverage?: Coverage;
  aiAvailable?: boolean;
  aiReason?: "ok" | "no_key" | "backoff";
};

type Progress = {
  answered: number;
  total: number;
  inFollowup: boolean;
  mode: Meta["mode"];
  currentKey: string | null;
  coverage: Coverage | null;
  aiAvailable: boolean;
  aiReason: "ok" | "no_key" | "backoff";
};

const RESET_COMMAND = "__reset__";
const SKIP_COMMAND = "__skip__";

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

// 各スロットを会話の「フェーズ名」として見せる
const STEP_LABEL: Record<string, string> = {
  trigger: "きっかけ",
  image: "IBMのイメージ",
  values: "大切にしたいこと",
  strengths: "強み・経験",
  concerns: "不安・迷い",
  work_style: "働き方",
  axis: "就活の軸",
};

// スコア(0..1)に応じた色（緑=十分 / 橙=手薄 / 暗=未取得）。ダーク背景向け。
function scoreColor(score: number, answered: boolean): string {
  if (!answered || score <= 0) return "rgba(255,255,255,0.16)";
  if (score >= 0.5) return "#34d399";
  return "#fbbf24";
}

// サイドバー用の円形プログレス（conic-gradient）
function ProgressRing({ pct, isDone }: { pct: number; isDone: boolean }) {
  const ring = isDone ? "#34d399" : "#4589ff";
  return (
    <div
      style={{
        position: "relative",
        width: 108,
        height: 108,
        borderRadius: "50%",
        background: `conic-gradient(${ring} ${pct * 3.6}deg, rgba(255,255,255,0.10) 0deg)`,
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
        boxShadow: `0 0 0 1px rgba(255,255,255,0.06), 0 8px 24px rgba(69,137,255,0.18)`,
      }}
    >
      <div
        style={{
          width: 82,
          height: 82,
          borderRadius: "50%",
          background: "#0c1526",
          display: "grid",
          placeItems: "center",
        }}
      >
        <div style={{ textAlign: "center", lineHeight: 1 }}>
          <div style={{ fontSize: 24, fontWeight: 800, color: "#fff" }}>
            {pct}
            <span style={{ fontSize: 12, marginLeft: 1 }}>%</span>
          </div>
          <div style={{ fontSize: 10, color: "#8aa0c4", marginTop: 4 }}>
            {isDone ? "完了" : "進行中"}
          </div>
        </div>
      </div>
    </div>
  );
}

// 観点ごとの取れ具合と全体の均等度を表示するパネル（ダークサイドバー向け）
function CoveragePanel({ coverage }: { coverage: Coverage | null }) {
  if (!coverage || coverage.axes.length === 0) return null;
  const anyAnswered = coverage.axes.some((a) => a.answered);
  if (!anyAnswered) return null;

  const weakest = coverage.axes.find((a) => a.id === coverage.weakestAxisId);
  const evenPct = Math.round(coverage.evenness * 100);
  const covPct = Math.round(coverage.coverage * 100);

  return (
    <div
      style={{
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 14,
        padding: "14px 14px",
        background: "rgba(255,255,255,0.04)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 12,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: "0.08em",
            color: "#9fb4d6",
          }}
        >
          観点バランス
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: "2px 8px",
            borderRadius: 999,
            border: coverage.balanced
              ? "1px solid rgba(52,211,153,0.4)"
              : "1px solid rgba(251,191,36,0.4)",
            background: coverage.balanced
              ? "rgba(52,211,153,0.12)"
              : "rgba(251,191,36,0.12)",
            color: coverage.balanced ? "#6ee7b7" : "#fcd34d",
          }}
        >
          {coverage.balanced ? "バランス良好" : "偏りあり"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {coverage.axes.map((a) => (
          <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontSize: 11,
                color: "#aebfda",
                width: 76,
                flexShrink: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              title={a.label}
            >
              {a.label}
            </span>
            <div
              style={{
                flex: 1,
                height: 6,
                background: "rgba(255,255,255,0.08)",
                borderRadius: 999,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.round(a.score * 100)}%`,
                  background: scoreColor(a.score, a.answered),
                  borderRadius: 999,
                  transition: "width 320ms ease",
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12, fontSize: 10, color: "#7e93b8" }}>
        充足度 {covPct}% ・ 均等度 {evenPct}%
        {!coverage.balanced && weakest && weakest.score < 0.5 && (
          <span>　/　手薄: {weakest.label}</span>
        )}
      </div>
    </div>
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
    currentKey: null,
    coverage: null,
    aiAvailable: true,
    aiReason: "ok",
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
      currentKey: (meta.currentKey as string) ?? null,
      coverage: (meta.coverage as Coverage) ?? null,
      aiAvailable: meta.aiAvailable !== false,
      aiReason: (meta.aiReason as Progress["aiReason"]) ?? "ok",
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

  const stepLabel = progress.currentKey
    ? STEP_LABEL[progress.currentKey] ?? null
    : null;
  const stepText = isDone
    ? "対話を振り返り中"
    : progress.total > 0
    ? `質問 ${Math.min(progress.answered + 1, progress.total)} / ${progress.total}`
    : "読み込み中…";

  return (
    <div className="app-shell">
      {/* ===== 左：ダッシュボード ===== */}
      <aside className="app-sidebar">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 11,
              background: "linear-gradient(135deg,#0f62fe,#4589ff)",
              display: "grid",
              placeItems: "center",
              fontWeight: 900,
              fontSize: 15,
              letterSpacing: "0.04em",
              color: "#fff",
              boxShadow: "0 6px 16px rgba(15,98,254,0.4)",
              flexShrink: 0,
            }}
          >
            IBM
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: "#fff" }}>
              就活の軸を深める対話
            </div>
            <div style={{ fontSize: 11, color: "#8aa0c4" }}>
              Career Axis Studio
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <ProgressRing pct={pct} isDone={isDone} />
          <div className="sidebar-detail" style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, color: "#8aa0c4" }}>現在のステップ</div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 800,
                color: "#fff",
                marginTop: 2,
              }}
            >
              {stepLabel ?? (isDone ? "まとめ" : "—")}
            </div>
            <div style={{ fontSize: 11, color: "#9fb4d6", marginTop: 4 }}>
              {stepText}
            </div>
            {progress.inFollowup && !isDone && (
              <span
                style={{
                  display: "inline-block",
                  marginTop: 8,
                  padding: "3px 9px",
                  borderRadius: 999,
                  background: "rgba(69,137,255,0.16)",
                  color: "#9ec1ff",
                  border: "1px solid rgba(69,137,255,0.35)",
                  fontSize: 10,
                  fontWeight: 700,
                }}
              >
                深掘り中
              </span>
            )}
          </div>
        </div>

        <div className="sidebar-detail">
          <CoveragePanel coverage={progress.coverage} />
        </div>

        {!progress.aiAvailable && (
          <div
            className="sidebar-detail"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
              padding: "10px 12px",
              borderRadius: 12,
              background: "rgba(251,191,36,0.10)",
              border: "1px solid rgba(251,191,36,0.3)",
              color: "#fcd34d",
              fontSize: 11,
              lineHeight: 1.5,
            }}
            role="status"
          >
            <span aria-hidden style={{ fontWeight: 800 }}>
              !
            </span>
            <span>
              {progress.aiReason === "no_key"
                ? "AI応答は現在オフです。定型のご質問でお伺いします（回答は記録されます）。"
                : "AI応答が一時的に利用しづらい状況です。復旧まで定型のご質問でお伺いします。"}
            </span>
          </div>
        )}

        <div className="sidebar-spacer" style={{ flex: 1 }} />

        <p
          className="sidebar-detail"
          style={{ fontSize: 11, color: "#6f84a8", lineHeight: 1.6, margin: 0 }}
        >
          合否を決めるものではありません。気になることはいつでも質問でき、
          途中の感覚のままでも大丈夫です。
        </p>
      </aside>

      {/* ===== 右：チャット ===== */}
      <main className="app-main">
        <div className="app-topbar">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 800, color: "#0f172a" }}>
              {isDone ? "対話が完了しました" : stepLabel ?? "IBM理解と就活の軸を深める対話"}
            </span>
            <span style={{ fontSize: 12, color: "#64748b", fontWeight: 700 }}>
              {pct}%
            </span>
          </div>
          <div
            style={{
              height: 6,
              width: "100%",
              background: "#e6e9f0",
              borderRadius: 999,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                background: isDone
                  ? "linear-gradient(90deg,#22c55e,#34d399)"
                  : "linear-gradient(90deg,#0f62fe,#4589ff)",
                borderRadius: 999,
                transition: "width 320ms ease",
              }}
            />
          </div>
        </div>

        <div ref={scrollRef} className="chat-scroll">
          <div className="chat-inner">
            {messages.map((m) =>
              m.role === "bot" && m.text === "" ? null : (
                <div
                  key={m.id}
                  style={{
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                    justifyContent:
                      m.role === "user" ? "flex-end" : "flex-start",
                  }}
                >
                  {m.role === "bot" && (
                    <div
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 9,
                        flexShrink: 0,
                        background: "linear-gradient(135deg,#0f62fe,#4589ff)",
                        color: "#fff",
                        display: "grid",
                        placeItems: "center",
                        fontSize: 11,
                        fontWeight: 800,
                        marginTop: 2,
                      }}
                    >
                      AI
                    </div>
                  )}
                  <div
                    style={{
                      maxWidth: "78%",
                      padding: "12px 15px",
                      borderRadius:
                        m.role === "user"
                          ? "16px 6px 16px 16px"
                          : "6px 16px 16px 16px",
                      border:
                        m.role === "user"
                          ? "none"
                          : "1px solid #e6e9f0",
                      background:
                        m.role === "user"
                          ? "linear-gradient(135deg,#0f62fe,#4589ff)"
                          : "#ffffff",
                      color: m.role === "user" ? "#fff" : "#0f172a",
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.7,
                      fontSize: 14,
                      boxShadow:
                        m.role === "user"
                          ? "0 6px 16px rgba(15,98,254,0.22)"
                          : "0 1px 2px rgba(16,24,40,0.05)",
                    }}
                  >
                    {m.text}
                  </div>
                </div>
              )
            )}
            {busy && (
              <div
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  color: "#94a3b8",
                  fontSize: 13,
                }}
              >
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 9,
                    background: "linear-gradient(135deg,#0f62fe,#4589ff)",
                    color: "#fff",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 11,
                    fontWeight: 800,
                    opacity: 0.7,
                  }}
                >
                  AI
                </div>
                回答を作成しています…
              </div>
            )}
          </div>
        </div>

        <div className="input-dock">
          <div className="input-inner">
            {warning && (
              <div
                style={{
                  padding: "10px 12px",
                  marginBottom: 10,
                  border: "1px solid #fca5a5",
                  borderRadius: 12,
                  background: "#fef2f2",
                  color: "#b91c1c",
                  fontSize: 13,
                }}
              >
                {warning}
              </div>
            )}
            <div
              style={{
                display: "flex",
                gap: 10,
                alignItems: "flex-end",
                background: isDone ? "#f3f4f6" : "#fff",
                border: "1px solid #d7dce5",
                borderRadius: 16,
                padding: 8,
                boxShadow: "0 2px 10px rgba(16,24,40,0.04)",
              }}
            >
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
                    ? "対話は完了しています"
                    : "メッセージを入力（Enterで送信 / Shift+Enterで改行）"
                }
                disabled={busy || isDone}
                rows={1}
                style={{
                  flex: 1,
                  resize: "none",
                  padding: "8px 10px",
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  color: "#0f172a",
                  fontSize: 14,
                  lineHeight: 1.6,
                  fontFamily: "inherit",
                  maxHeight: 160,
                  minHeight: 24,
                }}
              />
              <button
                className="send-btn"
                onClick={() => canSend && send(input)}
                disabled={!canSend}
                style={{
                  padding: "10px 18px",
                  borderRadius: 12,
                  border: "none",
                  background: canSend
                    ? "linear-gradient(135deg,#0f62fe,#4589ff)"
                    : "#e5e7eb",
                  color: canSend ? "#fff" : "#9ca3af",
                  cursor: canSend ? "pointer" : "default",
                  fontWeight: 800,
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                送信
              </button>
            </div>

            <div
              style={{
                marginTop: 10,
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <button
                className="ghost-btn"
                onClick={() => {
                  if (busy || isDone) return;
                  send(SKIP_COMMAND, "答えにくい・特になし");
                }}
                disabled={busy || isDone}
                title="この質問に答えにくい場合や、特になしの場合に次へ進みます"
                style={{
                  padding: "7px 13px",
                  borderRadius: 10,
                  border: "1px solid #d7dce5",
                  background: busy || isDone ? "#f3f4f6" : "#fff",
                  color: busy || isDone ? "#9ca3af" : "#475569",
                  cursor: busy || isDone ? "default" : "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                答えにくい・特になし
              </button>

              <button
                className="ghost-btn"
                onClick={() => {
                  if (busy) return;
                  if (
                    window.confirm("入力内容をすべて削除し、最初からやり直しますか？")
                  ) {
                    send(RESET_COMMAND, "最初から入力し直す");
                  }
                }}
                disabled={busy}
                style={{
                  padding: "7px 13px",
                  borderRadius: 10,
                  border: "1px solid #d7dce5",
                  background: "#fff",
                  color: "#475569",
                  cursor: busy ? "default" : "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                最初から入力し直す
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
