// lib/errors.ts
// アプリ共通のエラーコード体系。
// - サーバ内部の詳細(detail)はログに、お客様向けの userMessage は画面に出す。
// - すべてのレスポンスに requestId を付与し、ログと突き合わせて追跡できるようにする。
import crypto from "crypto";

export type ErrorCode =
  | "INVALID_JSON"
  | "EMPTY_TEXT"
  | "SESSION_ERROR"
  | "STATE_LOAD_ERROR"
  | "STATE_SAVE_ERROR"
  | "MESSAGE_LOG_ERROR"
  | "AI_TIMEOUT"
  | "AI_ERROR"
  | "DB_UNAVAILABLE"
  | "INTERNAL";

type CatalogEntry = { status: number; userMessage: string };

/** コード → HTTPステータス＋お客様向けメッセージ */
export const ERROR_CATALOG: Record<ErrorCode, CatalogEntry> = {
  INVALID_JSON: {
    status: 400,
    userMessage: "送信データの形式が正しくありません。お手数ですが、もう一度お試しください。",
  },
  EMPTY_TEXT: {
    status: 400,
    userMessage: "メッセージが空です。内容をご入力のうえ送信してください。",
  },
  SESSION_ERROR: {
    status: 500,
    userMessage: "セッションの確認に失敗しました。ページを再読み込みしてください。",
  },
  STATE_LOAD_ERROR: {
    status: 503,
    userMessage: "会話状態の読み込みに失敗しました。時間をおいて再度お試しください。",
  },
  STATE_SAVE_ERROR: {
    status: 503,
    userMessage: "ご回答の保存に失敗しました。時間をおいて再度お試しください。",
  },
  MESSAGE_LOG_ERROR: {
    status: 503,
    userMessage: "メッセージの記録に失敗しました。時間をおいて再度お試しください。",
  },
  AI_TIMEOUT: {
    status: 504,
    userMessage: "応答に時間がかかっています。恐れ入りますが、もう一度お試しください。",
  },
  AI_ERROR: {
    status: 502,
    userMessage: "応答の生成に失敗しました。時間をおいて再度お試しください。",
  },
  DB_UNAVAILABLE: {
    status: 503,
    userMessage: "現在サービスに接続できません。時間をおいて再度お試しください。",
  },
  INTERNAL: {
    status: 500,
    userMessage: "予期しないエラーが発生しました。時間をおいて再度お試しください。",
  },
};

/** 業務エラー。code から status / userMessage を導出する。 */
export class AppError extends Error {
  readonly code: ErrorCode;
  /** ログ用の詳細（お客様には出さない） */
  readonly detail?: string;

  constructor(code: ErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
  }

  get status(): number {
    return ERROR_CATALOG[this.code].status;
  }

  get userMessage(): string {
    return ERROR_CATALOG[this.code].userMessage;
  }
}

/** 未知の例外を AppError(INTERNAL) に正規化する。 */
export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const detail =
    e instanceof Error ? `${e.name}: ${e.message}` : String(e ?? "unknown");
  return new AppError("INTERNAL", detail);
}

/** 追跡用のリクエストID（短め）。 */
export function newRequestId(): string {
  return crypto.randomUUID().split("-")[0];
}

/** APIのエラーレスポンス body（GET/POSTの非ストリーム部・SSEのerrorイベント共通） */
export function errorBody(err: AppError, requestId: string) {
  return {
    error: {
      code: err.code,
      message: err.userMessage,
      requestId,
    },
  };
}
