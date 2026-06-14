// lib/gapfill.ts
// 終盤の「観点ギャップ補完」。coverage が手薄と判定した観点について、
// これまでの“自由な会話”全体を踏まえ、開かれた自然な質問を1つだけ生成する。
//
// 自由会話のメリットを損なわないための原則:
//   - 固定文の使い回しではなく、相手の言葉を受けた“開かれた”問いにする。
//   - 会話のどこかで既に十分語られていれば、質問を作らず covered=true（=聞かない）。
//   - AI不可/失敗時は covered 扱い（無理に固定質問を足さず、そのまま締める）。
import { runText, aiReady } from "./harness/aiRuntime";
import { ASSISTANT_PERSONA } from "./knowledge";

export type GapQuestion = {
  /** 会話の中で既に十分カバーされているか（trueなら聞かない） */
  covered: boolean;
  /** 生成された開かれた質問（covered=true や生成不可なら空文字） */
  ask: string;
  source: "ai" | "fallback";
};

function parseJsonLoose(text: string): any | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const unfenced = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 手薄な観点について、会話全体を踏まえた開かれた質問を1つ生成する。
 * @param axisLabel 補いたい観点の名称（例: 「価値観」）
 * @param context   これまでの回答ログ（collectedContext）
 */
export async function proposeGapQuestion(args: {
  axisLabel: string;
  context: string;
}): Promise<GapQuestion> {
  // AIが使えないなら、無理に固定質問を足さずそのまま締める。
  if (!aiReady("gapfill")) {
    return { covered: true, ask: "", source: "fallback" };
  }

  const prompt =
    ASSISTANT_PERSONA +
    "\n" +
    "これは自由な対話形式のヒアリングです。最後に、まだ十分に伺えていない観点について" +
    "もう一歩だけ自然にお聞きします。\n" +
    `補いたい観点: 「${args.axisLabel}」\n\n` +
    "これまでの会話:\n" +
    (args.context || "（まだほとんどありません）") +
    "\n\n" +
    "次の方針で、この観点についての質問を1つだけ作ってください:\n" +
    "・会話の流れと相手の言葉を受けた、開かれた（はい/いいえで終わらない）問いにする。\n" +
    "・固定的な定型文ではなく、その方に合わせて自然に。\n" +
    "・すでに会話の中でこの観点が十分に語られている場合は、質問を作らず covered=true にする。\n" +
    "・前置きや記号は付けず、質問本文のみ。\n\n" +
    "次の JSON 形式【のみ】で答えてください（前後に説明文やコードフェンスを付けない）:\n" +
    '{"covered": true または false, "ask": "質問本文。coveredがtrueなら空文字"}';

  // 終盤の補完は会話速度への影響が小さいので、やや長めのタイムアウトを許容する。
  const r = await runText("gapfill", "gapfill", prompt, {
    maxOutputTokens: 180,
    temperature: 0.5,
    thinkingBudget: 0,
    timeoutMs: Number(process.env.AI_TIMEOUT_GAPFILL_MS ?? "15000"),
  });
  if (!r.ok) return { covered: true, ask: "", source: "fallback" };

  const json = parseJsonLoose(r.value);
  if (!json) return { covered: true, ask: "", source: "fallback" };

  const covered = json.covered === true;
  const ask = String(json.ask ?? "").trim();
  if (covered || !ask) return { covered: true, ask: "", source: "ai" };
  return { covered: false, ask, source: "ai" };
}
