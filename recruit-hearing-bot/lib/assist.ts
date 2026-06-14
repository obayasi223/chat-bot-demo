// lib/assist.ts
// 「答えに詰まっている（unsure）」相談者を助けるための提案生成。
// IBMに入りたいか・合っていそうか迷っている方が、自分の考えを言葉にできるよう、
// これまでの会話ログ（既出の回答）を文脈に、考えるヒント・視点・例を一緒に挙げる。
// 速度優先: 思考オフ・短文・ストリーム。AI不可/失敗時は null（呼び出し側で定型文へ）。
import { runStream } from "./harness/aiRuntime";
import { ASSISTANT_PERSONA } from "./knowledge";

export type AssistResult = {
  /** 生成された提案（emit済み）。生成できなければ null */
  text: string | null;
  source: "ai" | "none";
};

/**
 * 詰まっている質問に対し、会話ログを踏まえた提案（ヒント／切り口／例）を生成してストリームする。
 * @param currentQuestion いま答えに詰まっている質問
 * @param context これまでの回答ログ（"- ラベル → 回答" の箇条書きなど）
 */
export async function streamUnsureAssist(
  args: { currentQuestion: string; context: string },
  onDelta: (s: string) => void
): Promise<AssistResult> {
  const lead = "迷うのは自然なことです。一緒に少し整理してみましょう。\n\n";

  const prompt =
    ASSISTANT_PERSONA +
    "\n" +
    "相談者様が次の問いに答えづらいご様子です。IBMに入りたいか・自分に合うか迷っている方が" +
    "自分の考えを言葉にできるよう、これまでのお話を踏まえて、考える助けになる" +
    "『具体的な視点・切り口・問いかけ』を2〜3個、簡潔な敬語で提案してください。\n" +
    "・各項目は「・」で始め、1行で短く。\n" +
    "・これまでのお話の内容（状況・価値観・強み・不安など）に結びつけて具体的に。\n" +
    "・本人の考えを決めつけず、あくまで考えるきっかけとして自然に提示。\n" +
    "・前置きや締めの定型文は不要。提案の箇条書きのみ出力。\n\n" +
    `答えづらい問い: ${args.currentQuestion}\n\n` +
    `これまでのお話:\n${args.context || "（まだありません）"}`;

  let started = false;
  const onDeltaLed = (d: string) => {
    if (!started) {
      onDelta(lead);
      started = true;
    }
    onDelta(d);
  };

  const r = await runStream("assist", "assist", prompt, onDeltaLed, {
    maxOutputTokens: 220,
    temperature: 0.4,
    thinkingBudget: 0,
    timeoutMs: Number(process.env.AI_TIMEOUT_ASSIST_MS ?? "10000"),
  });

  if (r.ok && r.value.trim()) {
    return { text: `${lead}${r.value}`, source: "ai" };
  }
  return { text: null, source: "none" };
}
