// lib/state.ts
// 会話の「状態」型定義。web_hearing の lib/state.ts を MVP 向けに簡素化したもの。

export type Role = "user" | "bot";

/** 1スロット（質問項目）への回答 */
export type AnswerValue = {
  /** ユーザーが最初に答えた本文 */
  raw: string;
  /** その質問のラベル（並び順や出力用に保持） */
  questionText: string;
  /** AI深掘りで追加収集した Q&A（最大1往復） */
  followups?: Array<{ question: string; answer: string }>;
  createdAt: string; // ISO
};

/** いま深掘り質問を出して回答待ちの状態 */
export type PendingFollowup = {
  /** 紐づく元スロットの key */
  key: string;
  /** ユーザーに出している深掘り質問文 */
  question: string;
  /** 深掘りラウンド（MVPは1回まで） */
  round: number;
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
