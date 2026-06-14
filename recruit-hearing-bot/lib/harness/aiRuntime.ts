// lib/harness/aiRuntime.ts
// AI呼び出しの「ハーネス」。すべてのAIアクセスをこのラッパ経由にして、
//   - サーキットブレーカ（遮断中は即スキップ）
//   - タイムアウト
//   - エラー分類（timeout/auth/rate/server/...）
//   - 低速・失敗の構造化ログ（テレメトリ）
//   - 成功/失敗の記録（回路へフィードバック）
// を一元化する。テキスト生成（runText）とストリーム生成（runStream）に対応。
import { generateText, generateTextStream, hasGemini } from "../gemini";
import { circuits, type AiFailType, type CircuitName } from "./circuit";

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? "10000");
const SLOW_MS = Number(process.env.AI_SLOW_MS ?? "6000");
const LOG_LEVEL = (process.env.AI_LOG_LEVEL ?? "warn") as
  | "off"
  | "error"
  | "warn"
  | "info"
  | "debug";

function shouldLog(level: "error" | "warn" | "info" | "debug") {
  const rank = { off: 99, error: 40, warn: 30, info: 20, debug: 10 } as const;
  return rank[level] >= rank[LOG_LEVEL];
}

function logJson(
  level: "error" | "warn" | "info" | "debug",
  payload: Record<string, unknown>
) {
  if (!shouldLog(level)) return;
  const line = JSON.stringify({ ts: Date.now(), ...payload });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** 例外メッセージから失敗種別を推定する。 */
export function classifyAiError(e: unknown): { type: AiFailType; message: string } {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.toLowerCase();
  if (m.includes("timeout") || m.includes("aborted") || m.includes("abort"))
    return { type: "timeout", message: msg };
  if (
    m.includes("401") ||
    m.includes("403") ||
    m.includes("api key") ||
    m.includes("permission")
  )
    return { type: "auth", message: msg };
  if (
    m.includes("429") ||
    m.includes("rate") ||
    m.includes("quota") ||
    m.includes("resource_exhausted")
  )
    return { type: "rate", message: msg };
  if (
    m.includes("500") ||
    m.includes("502") ||
    m.includes("503") ||
    m.includes("504")
  )
    return { type: "server", message: msg };
  return { type: "unknown", message: msg };
}

function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`timeout:${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(id);
        resolve(v);
      },
      (e) => {
        clearTimeout(id);
        reject(e);
      }
    );
    signal.addEventListener("abort", () => {
      clearTimeout(id);
      reject(new Error("aborted"));
    });
  });
}

export type AiRunResult<T> =
  | { ok: true; value: T; elapsedMs: number }
  | { ok: false; reason: "no_key" | "bypassed" | AiFailType; elapsedMs: number };

/** AIが利用可能か（鍵あり＆その回路が遮断中でない） */
export function aiReady(circuit: CircuitName): boolean {
  return hasGemini() && !circuits[circuit].shouldBypass();
}

/**
 * テキスト生成をハーネス経由で実行。
 * 失敗しても例外を投げず、{ ok:false, reason } を返す（呼び出し側でフォールバック）。
 */
export async function runText(
  phase: string,
  circuit: CircuitName,
  prompt: string,
  opts?: { timeoutMs?: number; maxOutputTokens?: number; temperature?: number }
): Promise<AiRunResult<string>> {
  const t0 = Date.now();
  if (!hasGemini()) return { ok: false, reason: "no_key", elapsedMs: 0 };
  if (circuits[circuit].shouldBypass()) {
    logJson("info", { event: "ai_bypass", phase, circuit });
    return { ok: false, reason: "bypassed", elapsedMs: 0 };
  }

  const ac = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  try {
    const value = await withTimeout(
      generateText(prompt, {
        signal: ac.signal,
        maxOutputTokens: opts?.maxOutputTokens,
        temperature: opts?.temperature,
      }),
      timeoutMs,
      ac.signal
    );
    circuits[circuit].recordSuccess();
    const elapsedMs = Date.now() - t0;
    if (elapsedMs >= SLOW_MS) {
      logJson("info", { event: "ai_slow", phase, circuit, elapsedMs });
    }
    return { ok: true, value, elapsedMs };
  } catch (e) {
    ac.abort();
    const { type, message } = classifyAiError(e);
    circuits[circuit].recordFailure(type, message);
    const elapsedMs = Date.now() - t0;
    logJson("warn", { event: "ai_error", phase, circuit, type, elapsedMs, message });
    return { ok: false, reason: type, elapsedMs };
  }
}

/**
 * ストリーム生成をハーネス経由で実行。差分は onDelta で逐次返す。
 * 戻り値で全文と成否を返す。失敗時は例外を投げず { ok:false } を返す。
 */
export async function runStream(
  phase: string,
  circuit: CircuitName,
  prompt: string,
  onDelta: (text: string) => void,
  opts?: { timeoutMs?: number; maxOutputTokens?: number; temperature?: number }
): Promise<AiRunResult<string>> {
  const t0 = Date.now();
  if (!hasGemini()) return { ok: false, reason: "no_key", elapsedMs: 0 };
  if (circuits[circuit].shouldBypass()) {
    logJson("info", { event: "ai_bypass", phase, circuit });
    return { ok: false, reason: "bypassed", elapsedMs: 0 };
  }

  const ac = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? TIMEOUT_MS;
  // 全体タイムアウト（最初のトークンまでではなく全体）。詰まり対策。
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let acc = "";
  try {
    for await (const delta of generateTextStream(prompt, {
      signal: ac.signal,
      maxOutputTokens: opts?.maxOutputTokens,
      temperature: opts?.temperature,
    })) {
      if (ac.signal.aborted) break;
      acc += delta;
      onDelta(delta);
    }
    clearTimeout(timer);
    circuits[circuit].recordSuccess();
    const elapsedMs = Date.now() - t0;
    if (elapsedMs >= SLOW_MS) {
      logJson("info", { event: "ai_slow", phase, circuit, elapsedMs });
    }
    return { ok: true, value: acc, elapsedMs };
  } catch (e) {
    clearTimeout(timer);
    ac.abort();
    const { type, message } = classifyAiError(e);
    circuits[circuit].recordFailure(type, message);
    const elapsedMs = Date.now() - t0;
    logJson("warn", { event: "ai_error", phase, circuit, type, elapsedMs, message });
    // 途中まで出ていれば、それを value として返す（部分成功）
    if (acc) return { ok: true, value: acc, elapsedMs };
    return { ok: false, reason: type, elapsedMs };
  }
}
