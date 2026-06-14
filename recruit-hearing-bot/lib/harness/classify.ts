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
  // 注: 「できます」「ます」等の丁寧な語尾は通常の回答にも頻出するため含めない
  //（疑問形は「ますか」「ですか」「でしょうか」で拾う）。
  "とは何",
  "方法は",
  "理由は",
];

// 「答えに詰まっている（=補足が必要）」を表す語。
// ※「特になし／なし／未定」などの“意図的に無い”は有効な回答として扱うため含めない。
const UNSURE_HINTS = [
  "わからない",
  "分からない",
  "わかりません",
  "分かりません",
  "わからん",
  "分からん",
  "思いつかない",
  "思いつきません",
  "思い浮かばない",
  "浮かばない",
  "出てこない",
  "見当がつかない",
  "見当もつかない",
  "決めてない",
  "決まってない",
  "決めかね",
  "迷ってる",
  "迷っている",
  "悩んでる",
  "悩んでいる",
  "答えられない",
  "答えづらい",
  "答えにくい",
  "ノーアイデア",
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
        "あなたはキャリア相談ヒアリングの分類器です。次の入力が、現在の問いへの『回答』か、" +
        "相談者からの『質問・相談』か、ヒアリングと無関係な『雑談』かを分類してください。\n" +
        "出力は次のいずれか1語のみ（説明禁止）: ANSWER / QUESTION / OFFTOPIC\n\n" +
        `現在の問い: ${currentQuestion}\n` +
        `入力: ${t}`;

  const r = await runText("classify", "classify", prompt, {
    maxOutputTokens: 4,
    temperature: 0,
    thinkingBudget: 0, // 思考オフ＝最速（分類は単純タスク）
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
