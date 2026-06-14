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

// 会話フェーズの並び（flows.ts のスロット順と一致）
const STEP_ORDER = [
  "trigger",
  "image",
  "values",
  "strengths",
  "concerns",
  "work_style",
  "axis",
];

// サイドバーの縦型ステッパー（全体の流れと現在地を可視化）
function Stepper({
  currentKey,
  isDone,
}: {
  currentKey: string | null;
  isDone: boolean;
}) {
  const idx = isDone
    ? STEP_ORDER.length
    : currentKey
    ? Math.max(0, STEP_ORDER.indexOf(currentKey))
    : 0;

  return (
    <div className="sidebar-detail" style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "#8d8d8d",
          marginBottom: 14,
        }}
      >
        対話の流れ
      </div>
      {STEP_ORDER.map((k, i) => {
        const done = isDone || i < idx;
        const current = !isDone && i === idx;
        const color = current ? "#ffffff" : done ? "#c6c6c6" : "#6f6f6f";
        return (
          <div
            key={k}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "7px 0",
            }}
          >
            <span
              style={{
                width: 24,
                height: 24,
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
                fontSize: 12,
                fontWeight: 600,
                color: current ? "#ffffff" : done ? "#0f62fe" : "#8d8d8d",
                background: current ? "#0f62fe" : "transparent",
                border: current
                  ? "1px solid #0f62fe"
                  : done
                  ? "1px solid #0f62fe"
                  : "1px solid #393939",
              }}
            >
              {done ? "✓" : i + 1}
            </span>
            <span
              style={{
                fontSize: 14,
                fontWeight: current ? 600 : 400,
                color,
              }}
            >
              {STEP_LABEL[k]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// スコア(0..1)に応じた色（緑=十分 / 黄=手薄 / 暗=未取得）。Carbon配色。
function scoreColor(score: number, answered: boolean): string {
  if (!answered || score <= 0) return "#393939";
  if (score >= 0.5) return "#42be65";
  return "#f1c21b";
}

// サイドバー用の円形プログレス（フラットなリング）
function ProgressRing({ pct, isDone }: { pct: number; isDone: boolean }) {
  const ring = isDone ? "#42be65" : "#4589ff";
  return (
    <div
      style={{
        position: "relative",
        width: 116,
        height: 116,
        borderRadius: "50%",
        background: `conic-gradient(${ring} ${pct * 3.6}deg, #393939 0deg)`,
        display: "grid",
        placeItems: "center",
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 88,
          height: 88,
          borderRadius: "50%",
          background: "#161616",
          display: "grid",
          placeItems: "center",
        }}
      >
        <div style={{ textAlign: "center", lineHeight: 1 }}>
          <div style={{ fontSize: 30, fontWeight: 600, color: "#ffffff" }}>
            {pct}
            <span style={{ fontSize: 15, marginLeft: 1 }}>%</span>
          </div>
          <div style={{ fontSize: 12, color: "#a8a8a8", marginTop: 6 }}>
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
        borderTop: "1px solid #393939",
        paddingTop: 20,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "#8d8d8d",
          }}
        >
          観点バランス
        </span>
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            padding: "2px 10px",
            borderLeft: `2px solid ${coverage.balanced ? "#42be65" : "#f1c21b"}`,
            color: coverage.balanced ? "#42be65" : "#f1c21b",
          }}
        >
          {coverage.balanced ? "バランス良好" : "偏りあり"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {coverage.axes.map((a) => (
          <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              style={{
                fontSize: 13,
                color: "#c6c6c6",
                width: 84,
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
                background: "#393939",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.round(a.score * 100)}%`,
                  background: scoreColor(a.score, a.answered),
                  transition: "width 320ms ease",
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, fontSize: 12, color: "#8d8d8d" }}>
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
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span
            style={{
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: "#0f62fe",
              flexShrink: 0,
            }}
          >
            IBM
          </span>
          <span style={{ fontSize: 16, fontWeight: 600, color: "#fff" }}>
            就活の軸を深める対話
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <ProgressRing pct={pct} isDone={isDone} />
          <div className="sidebar-detail" style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                color: "#8d8d8d",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              現在のステップ
            </div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 600,
                color: "#fff",
                marginTop: 4,
              }}
            >
              {stepLabel ?? (isDone ? "まとめ" : "—")}
            </div>
            <div style={{ fontSize: 14, color: "#c6c6c6", marginTop: 6 }}>
              {stepText}
            </div>
            {progress.inFollowup && !isDone && (
              <span
                style={{
                  display: "inline-block",
                  marginTop: 12,
                  padding: "3px 10px",
                  background: "rgba(69,137,255,0.16)",
                  color: "#a6c8ff",
                  borderLeft: "2px solid #4589ff",
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                深掘り中
              </span>
            )}
          </div>
        </div>

        <Stepper currentKey={progress.currentKey} isDone={isDone} />

        <div className="sidebar-detail">
          <CoveragePanel coverage={progress.coverage} />
        </div>

        {!progress.aiAvailable && (
          <div
            className="sidebar-detail"
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              padding: "12px 14px",
              background: "rgba(241,194,27,0.10)",
              borderLeft: "2px solid #f1c21b",
              color: "#f1c21b",
              fontSize: 13,
              lineHeight: 1.6,
            }}
            role="status"
          >
            <span>
              {progress.aiReason === "no_key"
                ? "AI応答は現在オフです。定型のご質問でお伺いします（回答は記録されます）。"
                : "AI応答が一時的に利用しづらい状況です。復旧まで定型のご質問でお伺いします。"}
            </span>
          </div>
        )}

        <div className="sidebar-spacer" style={{ flex: 1 }} />
      </aside>

      {/* ===== 右：チャット ===== */}
      <main className="app-main">
        <div className="app-topbar">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 10,
            }}
          >
            <span style={{ fontSize: 17, fontWeight: 600, color: "#161616" }}>
              {isDone ? "対話が完了しました" : stepLabel ?? "IBM理解と就活の軸を深める対話"}
            </span>
            <span style={{ fontSize: 14, color: "#525252", fontWeight: 500 }}>
              {pct}%
            </span>
          </div>
          <div style={{ height: 4, width: "100%", background: "#e0e0e0" }}>
            <div
              style={{
                height: "100%",
                width: `${pct}%`,
                background: isDone ? "#24a148" : "#0f62fe",
                transition: "width 320ms ease",
              }}
            />
          </div>
        </div>

        <div ref={scrollRef} className="chat-scroll">
          <div className="chat-inner">
            <div
              style={{
                borderLeft: "2px solid #0f62fe",
                padding: "2px 0 2px 14px",
                color: "#6f6f6f",
                fontSize: 13,
                lineHeight: 1.7,
              }}
            >
              IBMを知りながら、あなたの「就活の軸」を一緒に言葉にする対話。
            </div>
            {messages.map((m) =>
              m.role === "bot" && m.text === "" ? null : (
                <div
                  key={m.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems:
                      m.role === "user" ? "flex-end" : "flex-start",
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                      color: m.role === "user" ? "#0f62fe" : "#6f6f6f",
                      marginBottom: 6,
                      padding: "0 2px",
                    }}
                  >
                    {m.role === "user" ? "あなた" : "アシスタント"}
                  </span>
                  <div
                    style={{
                      maxWidth: "84%",
                      padding: "14px 18px",
                      borderRadius: 8,
                      border: "none",
                      background: m.role === "user" ? "#0f62fe" : "#f2f4f8",
                      color: m.role === "user" ? "#ffffff" : "#161616",
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.8,
                      fontSize: 16,
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
                  alignItems: "center",
                  gap: 8,
                  color: "#6f6f6f",
                  fontSize: 15,
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "#0f62fe",
                    display: "inline-block",
                  }}
                />
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
                  padding: "12px 14px",
                  marginBottom: 12,
                  borderLeft: "2px solid #da1e28",
                  background: "#fff1f1",
                  color: "#a2191f",
                  fontSize: 14,
                }}
              >
                {warning}
              </div>
            )}
            <div
              style={{
                display: "flex",
                gap: 0,
                alignItems: "stretch",
                background: isDone ? "#f4f4f4" : "#fff",
                border: "1px solid #8d8d8d",
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
                  padding: "14px 16px",
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  color: "#161616",
                  fontSize: 16,
                  lineHeight: 1.6,
                  fontFamily: "inherit",
                  maxHeight: 180,
                  minHeight: 28,
                }}
              />
              <button
                className="send-btn"
                onClick={() => canSend && send(input)}
                disabled={!canSend}
                style={{
                  padding: "0 28px",
                  border: "none",
                  background: canSend ? "#0f62fe" : "#c6c6c6",
                  color: "#ffffff",
                  cursor: canSend ? "pointer" : "default",
                  fontWeight: 600,
                  fontSize: 16,
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                送信
              </button>
            </div>

            <div
              style={{
                marginTop: 12,
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
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
                  padding: "9px 16px",
                  border: "1px solid #8d8d8d",
                  background: busy || isDone ? "#f4f4f4" : "#fff",
                  color: busy || isDone ? "#a8a8a8" : "#393939",
                  cursor: busy || isDone ? "default" : "pointer",
                  fontSize: 14,
                  fontWeight: 500,
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
                  padding: "9px 16px",
                  border: "1px solid #8d8d8d",
                  background: "#fff",
                  color: "#393939",
                  cursor: busy ? "default" : "pointer",
                  fontSize: 14,
                  fontWeight: 500,
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
