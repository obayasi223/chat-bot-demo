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

// 強い疑問シグナル（高精度）。これがあれば質問とみなしてよい。
// 文末の「か」系の疑問形・明示的な依頼表現に絞る。
const STRONG_QUESTION = [
  "?",
  "？",
  "ですか",
  "ますか",
  "でしょうか",
  "ありますか",
  "いいですか",
  "可能ですか",
  "教えて",
  "教えてください",
  "知りたい",
  "聞きたい",
];

// 弱い疑問シグナル（疑問詞）。埋め込み節などで誤検出しやすいので“曖昧”として扱う。
// ※「どう」「なん」「何」単体は『〜かどうか』『何か』『なんとなく』等の平叙文に頻出するため入れない。
//   （疑問詞として拾うときは「どうして」「何を」など、より具体的な形に限定する）
const WEAK_QUESTION = [
  "なぜ",
  "どうして",
  "どうやって",
  "どこ",
  "いつ",
  "いくら",
  "どれ",
  "どちら",
  "どの",
  "何を",
  "何が",
  "何で",
  "なにを",
  "なにが",
];

/** 長い入力は埋め込み節に疑問詞が混じりやすい。これ未満のみ弱シグナルを採用する。 */
const WEAK_QUESTION_MAXLEN = Number(process.env.CLASSIFY_WEAK_MAXLEN ?? "40");

function hasStrongQuestion(t: string): boolean {
  return STRONG_QUESTION.some((w) => t.includes(w));
}
function hasWeakQuestion(t: string): boolean {
  return WEAK_QUESTION.some((w) => t.includes(w));
}

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
  if (hasStrongQuestion(t)) return true;
  // 弱シグナルは短文のときのみ採用（長い平叙文の埋め込み節を誤検出しない）
  return t.length <= WEAK_QUESTION_MAXLEN && hasWeakQuestion(t);
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
 * 分類モード:
 *  - "ai"     : 毎ターン必ずAIで分類（精度優先）。AI不可/失敗時はヒューリスティックへ。
 *  - "hybrid" : 明確な入力はヒューリスティックで即確定し、曖昧なときだけAI（速度優先）。
 */
const CLASSIFY_MODE = (process.env.CLASSIFY_MODE ?? "ai").toLowerCase() as
  | "ai"
  | "hybrid";

/** ヒューリスティックのみで方向を確定する（AI不可時の土台・hybridの即決にも使う）。 */
function heuristicDecide(t: string): Classification {
  if (looksUnsure(t)) return decide("unsure", 0.8, "heuristic");
  const strong = hasStrongQuestion(t);
  const weak = !strong && t.length <= WEAK_QUESTION_MAXLEN && hasWeakQuestion(t);
  if (strong) return decide("question", 0.6, "heuristic");
  if (weak) return decide("question", 0.55, "heuristic");
  // 質問っぽさが無ければ回答（IBM: current node priority）
  return decide("answer", 0.8, "heuristic");
}

/** 軽量AIで answer/question/unsure/offtopic を判定。失敗時は fallback を返す。 */
async function aiClassify(
  currentQuestion: string,
  t: string,
  fallback: Classification
): Promise<Classification> {
  if (!aiReady("classify")) return fallback;

  const prompt =
    "あなたはキャリア相談ヒアリングの分類器です。いま尋ねている問いに対するユーザーの入力を、" +
    "次の4種類のいずれかに分類してください。\n" +
    "- ANSWER: 問いへの回答（自分の考え・経験・気持ち・状況を述べている。断定や箇条書き、" +
    "「〜したい」「〜を重視」「〜かどうか…」のような平叙文を含む）\n" +
    "- QUESTION: 相談者からの質問・相談（こちらに情報や判断を求めている）\n" +
    "- UNSURE: 答えに詰まっている・わからない・迷っていて回答になっていない\n" +
    "- OFFTOPIC: ヒアリングと無関係な雑談\n" +
    "迷ったら ANSWER を優先（平叙文は基本 ANSWER）。出力は1語のみ（説明禁止）。\n\n" +
    `現在の問い: ${currentQuestion}\n` +
    `入力: ${t}\n` +
    "分類:";

  const r = await runText("classify", "classify", prompt, {
    maxOutputTokens: 6,
    temperature: 0,
    thinkingBudget: 0, // 思考オフ＝最速（分類は単純タスク）
    timeoutMs: Number(process.env.AI_TIMEOUT_CLASSIFY_MS ?? "5000"),
  });
  if (!r.ok) return fallback;
  const label = parseLabel(r.value);
  if (!label) return fallback;
  return decide(label, 0.85, "ai");
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
  if (!t) return decide("empty", 1, "heuristic");

  // ヒューリスティック結果は、AI不可/失敗時のフォールバック土台として常に用意する。
  const heur = heuristicDecide(t);

  if (CLASSIFY_MODE === "ai") {
    // 毎ターン必ずAIで分類（精度優先）。AIが使えない/失敗したらヒューリスティックへ。
    return aiClassify(currentQuestion, t, heur);
  }

  // hybrid: 明確なものは即確定、曖昧（質問っぽい）ときだけAIに最終判定を委ねる。
  if (heur.vector === "unsure" || heur.vector === "answer") return heur;
  return aiClassify(currentQuestion, t, heur);
}
