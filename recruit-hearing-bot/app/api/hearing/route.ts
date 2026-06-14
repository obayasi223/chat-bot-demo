// app/api/hearing/route.ts
// チャットのサーバエンドポイント。
// - GET : 状態を読み込み、未開始なら開始して最初の質問を返す。履歴も返す。
// - POST: ユーザー発話を1ターン処理し、bot 応答を SSE でストリーミングする。
// すべてのレスポンスに requestId を付与し、エラーは {error:{code,message,requestId}} 形式で返す。
import { NextResponse } from "next/server";
import { getOrCreateSessionId } from "@/lib/session";
import { loadState, saveState } from "@/lib/dbState";
import { appendMessage, getMessages } from "@/lib/dbMessages";
import { handleTurnStream, startFlow, metaOf, RESET_COMMAND } from "@/lib/handleText";
import {
  AppError,
  toAppError,
  newRequestId,
  errorBody,
  type ErrorCode,
} from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 内部コマンドを人間に読める表示へ変換（チャットログ用）
function displayUserText(text: string): string {
  if (text === RESET_COMMAND) return "最初から入力し直す";
  return text;
}

// エラーJSONレスポンス（非ストリーム部）
function jsonError(err: AppError, requestId: string) {
  console.error("[api/hearing] error", {
    requestId,
    code: err.code,
    detail: err.detail,
  });
  return NextResponse.json(errorBody(err, requestId), {
    status: err.status,
    headers: { "x-request-id": requestId },
  });
}

// 指定コードで包んで投げ直すヘルパ
async function step<T>(code: ErrorCode, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new AppError(code, e instanceof Error ? e.message : String(e));
  }
}

export async function GET() {
  const requestId = newRequestId();
  try {
    const sid = await step("SESSION_ERROR", () => getOrCreateSessionId());
    const state = await step("STATE_LOAD_ERROR", () => loadState(sid));

    // 未開始なら開始（最初のbot発話をログに残す）
    if (!state.flowId || state.mode === "idle") {
      const intro = startFlow(state);
      await step("STATE_SAVE_ERROR", () => saveState(sid, state));
      await step("MESSAGE_LOG_ERROR", () => appendMessage(sid, "bot", intro));
    }

    const messages = await step("STATE_LOAD_ERROR", () => getMessages(sid));
    return NextResponse.json(
      {
        messages,
        lastBotText: state.lastBotText ?? "",
        meta: metaOf(state),
      },
      { headers: { "x-request-id": requestId } }
    );
  } catch (e) {
    return jsonError(toAppError(e), requestId);
  }
}

// SSE の1イベントを組み立てる
function sseEvent(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

export async function POST(req: Request) {
  const requestId = newRequestId();

  // --- 受信データの検証 ---
  let body: any = null;
  try {
    body = await req.json();
  } catch {
    return jsonError(new AppError("INVALID_JSON"), requestId);
  }
  const text = String(body?.text ?? "").trim();
  if (!text) return jsonError(new AppError("EMPTY_TEXT"), requestId);

  // --- 前処理（ストリーム返却前に解決：Cookie確定・状態読込・ユーザー発話ログ） ---
  let sid: string;
  let state;
  try {
    sid = await step("SESSION_ERROR", () => getOrCreateSessionId());
    state = await step("STATE_LOAD_ERROR", () => loadState(sid));
    await step("MESSAGE_LOG_ERROR", () =>
      appendMessage(sid, "user", displayUserText(text))
    );
  } catch (e) {
    return jsonError(toAppError(e), requestId);
  }

  // --- ストリーム本体 ---
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(sseEvent(obj)));
      try {
        // 1ターン処理：差分はそのまま delta として流す（最速で表示）
        const result = await handleTurnStream(state, text, (delta) => {
          send({ type: "delta", text: delta });
        });

        // 状態保存（失敗は致命的：エラーイベントで通知）
        await step("STATE_SAVE_ERROR", () => saveState(sid, state));

        // bot応答のログ（失敗しても会話は継続：警告ログのみ）
        try {
          await appendMessage(sid, "bot", result.outText);
        } catch (e) {
          console.error("[POST /api/hearing] bot log failed (non-fatal)", {
            requestId,
            detail: e instanceof Error ? e.message : String(e),
          });
        }

        send({
          type: "done",
          outText: result.outText,
          meta: result.meta,
          requestId,
        });
      } catch (e) {
        const err = toAppError(e);
        console.error("[POST /api/hearing] stream failed", {
          requestId,
          code: err.code,
          detail: err.detail,
        });
        send({
          type: "error",
          code: err.code,
          message: err.userMessage,
          requestId,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // ストリームのバッファリングを抑止（リバースプロキシ対策）
      "x-accel-buffering": "no",
      "x-request-id": requestId,
    },
  });
}
