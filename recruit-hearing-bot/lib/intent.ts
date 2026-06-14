// lib/intent.ts
// ナレッジ回答の生成（answer-only）。
// 「回答か質問か」の判定は harness/classify.ts に移譲済み。ここは
// 「質問だと確定した入力」に対して、最速でナレッジ参照して答えることに専念する。
// 速度優先の順序: FAQ簡易マッチ（即時） → 軽量AIストリーム → 定型フォールバック。
import { runStream } from "./harness/aiRuntime";
import {
  ASSISTANT_PERSONA,
  knowledgeForPrompt,
  findFaqAnswer,
  FALLBACK_ANSWER,
} from "./knowledge";

export type KnowledgeAnswer = {
  /** 回答全文（emit済み） */
  text: string;
  source: "faq" | "ai" | "fallback";
};

/**
 * 質問へナレッジで回答し、差分を onDelta で逐次返す。
 * - FAQに当たれば即返す（AIを呼ばない＝最速）
 * - 外れたらAIストリーム（ナレッジを文脈に、無ければ担当者へ引き継ぎ）
 * - AI不可/失敗なら定型フォールバック
 */
export async function streamKnowledgeAnswer(
  args: { currentQuestion: string; userText: string },
  onDelta: (s: string) => void
): Promise<KnowledgeAnswer> {
  // 1) FAQ簡易マッチ（決定的・即時）
  const faq = findFaqAnswer(args.userText);
  if (faq) {
    onDelta(faq);
    return { text: faq, source: "faq" };
  }

  // 2) 軽量AIストリーム
  const prompt =
    ASSISTANT_PERSONA +
    "\n" +
    "ご応募者様からの質問・相談に、下記ナレッジを参考に丁寧な敬語で簡潔に回答してください。\n" +
    "ナレッジに無い内容は推測せず、『恐れ入りますが、その点は採用担当者より追ってご回答いたします』と伝えてください。\n" +
    "前置き・記号・引用符・コードフェンスは付けないでください。\n\n" +
    `（参考）現在の質問: ${args.currentQuestion}\n` +
    `ご応募者様の入力: ${args.userText}\n\n` +
    "【ナレッジ】\n" +
    knowledgeForPrompt();

  const r = await runStream("answer", "answer", prompt, onDelta, {
    maxOutputTokens: 256,
    temperature: 0.3,
    timeoutMs: Number(process.env.AI_TIMEOUT_ANSWER_MS ?? "10000"),
  });

  if (r.ok && r.value.trim()) {
    return { text: r.value, source: "ai" };
  }

  // 3) フォールバック（AIが何も返せなかった場合のみ。部分出力済みなら追記しない）
  onDelta(FALLBACK_ANSWER);
  return { text: FALLBACK_ANSWER, source: "fallback" };
}
