// lib/state.ts
// 会話の「状態」型定義。web_hearing の lib/state.ts を MVP 向けに簡素化したもの。

export type Role = "user" | "bot";

/** 回答からAIが推定した「情報の十分さ」 */
export type Sufficiency =
  | "sufficient" // 本人を理解するのに十分に語られた
  | "partial" // 一部のみ。深掘り上限到達やスキップで前進した
  | "unknown"; // 未判定（AI不可・非深掘りスロットなど）

/** 1スロット（質問項目）への回答 */
export type AnswerValue = {
  /** ユーザーが最初に答えた本文 */
  raw: string;
  /** その質問のラベル（並び順や出力用に保持） */
  questionText: string;
  /** AI深掘りで追加収集した Q&A（複数往復あり） */
  followups?: Array<{ question: string; answer: string }>;
  /** 回答から推定した情報の十分さ（「十分に取れたか」の推測結果） */
  sufficiency?: Sufficiency;
  createdAt: string; // ISO
};

/** いま深掘り質問を出して回答待ちの状態 */
export type PendingFollowup = {
  /** 紐づく元スロットの key */
  key: string;
  /** ユーザーに出している深掘り質問文 */
  question: string;
  /** これまでに出した深掘り質問の回数（1始まり。上限は AI_DEEPEN_MAX_ROUNDS） */
  round: number;
  /**
   * 質問の種類:
   * - "deepen"  : 通常の深掘り（回答の十分性判定ループ）
   * - "gapfill" : 終盤、手薄な観点を補う「開かれた質問」
   * 省略時は "deepen" とみなす。
   */
  kind?: "deepen" | "gapfill";
} | null;

export type State = {
  /** 進行中フローのID（未開始は null） */
  flowId: string | null;
  /** idle=未開始 / collecting=ヒアリング中 / done=完了 */
  mode: "idle" | "collecting" | "done";
  /** いま尋ねているスロットの index */
  currentIndex: number;
  /** key -> 回答 */
  answers: Record<string, AnswerValue>;
  /** 深掘り待ち */
  pendingFollowup: PendingFollowup;
  /** 終盤の観点ギャップ補完で、これまでに尋ねた回数（上限は AI_GAPFILL_MAX_QUESTIONS） */
  gapfillAsked?: number;
  /** リロード復帰用：最後にbotが出した文面 */
  lastBotText?: string;
};

export function blankState(): State {
  return {
    flowId: null,
    mode: "idle",
    currentIndex: 0,
    answers: {},
    pendingFollowup: null,
    lastBotText: "",
  };
}
