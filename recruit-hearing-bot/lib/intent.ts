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
 * - 外れたらAIストリーム（ナレッジを文脈に、無ければ無理に答えず対話を続ける）
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
      "相談者様からの質問・相談に、下記ナレッジを土台に、丁寧で親身な敬語で自然に回答してください。\n" +
      "・ナレッジはそのまま読み上げず、相手の言葉や文脈に合わせて自然な言い回しに変えて構いません。\n" +
      "・ナレッジに直接書かれていなくても、一般的に説明できる範囲なら簡潔にお答えして構いません。\n" +
      "・確かな情報が無い場合は断定を避け、分かる範囲でお答えしたうえで対話を続けてください（外部の窓口や担当者への取次は案内しないでください）。\n" +
      "・前置き・記号・引用符・コードフェンスは付けないでください。\n\n" +
      `（参考）現在の問い: ${args.currentQuestion}\n` +
      `相談者様の入力: ${args.userText}\n\n` +
      "【ナレッジ】\n" +
      knowledgeForPrompt();

  const r = await runStream("answer", "answer", prompt, onDelta, {
    maxOutputTokens: 256,
    temperature: 0.3,
    thinkingBudget: 0, // 思考オフ＝最速（FAQベースの短文回答）
    timeoutMs: Number(process.env.AI_TIMEOUT_ANSWER_MS ?? "10000"),
  });

  if (r.ok && r.value.trim()) {
    return { text: r.value, source: "ai" };
  }

  // 3) フォールバック（AIが何も返せなかった場合のみ。部分出力済みなら追記しない）
  onDelta(FALLBACK_ANSWER);
  return { text: FALLBACK_ANSWER, source: "fallback" };
}
