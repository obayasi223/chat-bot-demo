// lib/harness/classify.ts
// 入力を「ベクトル（カテゴリ）」へ高速分類し、次にAIが取るべき「方向（Direction）」を決める。
// 速度重視の2段構え:
//   1) ヒューリスティック（決定的・即時）でほとんどのターンを確定
//   2) 曖昧なときだけ軽量AIラベル呼び出し（出力数トークン）で判定
// これによりナレッジ参照（FAQ）に入る判断を最速で下す。
import { runText, aiReady } from "./aiRuntime";

/** 入力の意味カテゴリ（ベクトル） */
export type TurnVector =
  | "answer" // 現在の質問への回答
  | "question" // 質問・相談（ナレッジ参照が必要）
  | "unsure" // 「わからない」等、回答に詰まっている
  | "offtopic" // 無関係・雑談
  | "empty"; // 空

/** 分類の結果、次に取るべき方向 */
export type Direction =
  | "PROCEED" // 回答として確定 → 保存・深掘り・前進
  | "ANSWER_QUESTION" // ナレッジ参照で回答 → 元の質問へ戻す
  | "CLARIFY" // 補足を促して同じ質問へ
  | "FALLBACK"; // 担当者へ引き継ぎ → 元の質問へ戻す

export type Classification = {
  vector: TurnVector;
  direction: Direction;
  confidence: number; // 0..1
  source: "heuristic" | "ai" | "fallback";
};

const VECTOR_TO_DIRECTION: Record<TurnVector, Direction> = {
  answer: "PROCEED",
  question: "ANSWER_QUESTION",
  unsure: "CLARIFY",
  offtopic: "FALLBACK",
  empty: "CLARIFY",
};

function decide(
  vector: TurnVector,
  confidence: number,
  source: Classification["source"]
): Classification {
  return { vector, direction: VECTOR_TO_DIRECTION[vector], confidence, source };
}

// --- ヒューリスティック用シグナル ---

const QUESTION_HINTS = [
  "?",
  "？",
  "ですか",
  "でしょうか",
  "ますか",
  "教え",
  "知りたい",
  "聞きたい",
  "なぜ",
  "どうやって",
  "どう",
  "どの",
  "どこ",
  "いつ",
  "いくら",
  "どれ",
  "どちら",
  "何",
  "なに",
  "なん",
  "可能",
  "できます",
  "とは",
  "について",
  "方法",
  "理由",
  "意味",
];

const UNSURE_HINTS = [
  "わからない",
  "分からない",
  "わかりません",
  "分かりません",
  "思いつかない",
  "決めてない",
  "決まってない",
  "特にない",
  "特になし",
  "なし",
  "ない",
  "未定",
  "迷ってる",
  "迷っている",
];

export function looksLikeQuestion(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return QUESTION_HINTS.some((w) => t.includes(w));
}

function looksUnsure(text: string): boolean {
  const t = String(text ?? "").trim();
  // 短く、かつ「わからない」系の語のみ → unsure
  if (t.length > 24) return false;
  return UNSURE_HINTS.some((w) => t === w || t.includes(w));
}

/** 軽量AIラベル分類のパース */
function parseLabel(raw: string): TurnVector | null {
  const t = raw.trim().toUpperCase();
  if (t.startsWith("ANSWER")) return "answer";
  if (t.startsWith("QUESTION")) return "question";
  if (t.startsWith("UNSURE")) return "unsure";
  if (t.startsWith("OFFTOPIC")) return "offtopic";
  return null;
}

/**
 * 1ターンを分類して方向を決める。
 * @param currentQuestion いま尋ねている質問文
 * @param text ユーザー入力
 */
export async function classifyTurn(
  currentQuestion: string,
  text: string
): Promise<Classification> {
  const t = String(text ?? "").trim();

  // 1) 即時ヒューリスティック
  if (!t) return decide("empty", 1, "heuristic");
  if (looksUnsure(t)) return decide("unsure", 0.8, "heuristic");
  // 質問っぽさが無ければ、ほぼ回答（IBM: current node priority）
  if (!looksLikeQuestion(t)) return decide("answer", 0.75, "heuristic");

  // 2) 曖昧（質問っぽい）→ 軽量AIで answer/question/offtopic を判定
  if (!aiReady("classify")) {
    // AI不可：質問っぽいので質問として扱う（取りこぼし防止）
    return decide("question", 0.5, "fallback");
  }

  const prompt =
    "あなたは採用ヒアリングの分類器です。次の入力が、現在の質問への『回答』か、" +
    "応募者からの『質問・相談』か、ヒアリングと無関係な『雑談』かを分類してください。\n" +
    "出力は次のいずれか1語のみ（説明禁止）: ANSWER / QUESTION / OFFTOPIC\n\n" +
    `現在の質問: ${currentQuestion}\n` +
    `入力: ${t}`;

  const r = await runText("classify", "classify", prompt, {
    maxOutputTokens: 4,
    temperature: 0,
    timeoutMs: Number(process.env.AI_TIMEOUT_CLASSIFY_MS ?? "5000"),
  });

  if (!r.ok) {
    // AI失敗/遮断：質問として扱う（フォールバック）
    return decide("question", 0.5, "fallback");
  }
  const label = parseLabel(r.value);
  if (!label) return decide("question", 0.5, "fallback");
  return decide(label, 0.85, "ai");
}
