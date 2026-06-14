// lib/aiDeepen.ts
// AI深掘り：回答が薄いとき、追加で1つだけ質問を作る。
// AI呼び出しは harness（サーキット＋タイムアウト＋テレメトリ）経由に統一。
import { runText, runStream } from "./harness/aiRuntime";

export type DeepenResult = {
  needFollowup: boolean;
  question?: string;
};

/** 回答が十分なときにAIが先頭に出力するマーカー */
const SUFFICIENT_MARK = "[OK]";

const DEEPEN_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_DEEPEN_MS ?? "12000");

/** ```json ... ``` などを剥がして最初のJSONオブジェクトを取り出す */
function parseJsonLoose(text: string): any | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  // コードフェンス除去
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
 * 直前の回答を見て、評価に足りなければ追加質問を1つ作る。
 * - Gemini 未設定／失敗時は needFollowup:false（=固定フローのみで進行）
 */
export async function proposeFollowup(args: {
  questionLabel: string;
  answer: string;
}): Promise<DeepenResult> {
  const answer = String(args.answer ?? "").trim();
  if (!answer) return { needFollowup: false };

  const prompt =
    "あなたは丁寧で簡潔な採用担当者です。ご応募者様への事前ご案内を行っています。\n" +
    "以下の「質問」と「ご応募者様の回答」を読み、選考を進めるうえで具体性が十分か判断してください。\n" +
    "不足している場合は、より具体的な情報（実績・数字・役割・期間・背景など）をお伺いする追加質問を1つだけ、" +
    "丁寧な敬語で短く作ってください。十分なら追加質問は不要です。\n\n" +
    `質問: ${args.questionLabel}\n` +
    `ご応募者様の回答: ${answer}\n\n` +
    "次のJSON形式【のみ】で答えてください（前後に説明文やコードフェンスを付けない）:\n" +
    '{"needFollowup": true または false, "question": "追加質問。needFollowupがfalseなら空文字"}';

  const r = await runText("deepen", "deepen", prompt, {
    maxOutputTokens: 200,
    temperature: 0.3,
    timeoutMs: DEEPEN_TIMEOUT_MS,
  });
  if (!r.ok) return { needFollowup: false };

  const json = parseJsonLoose(r.value);
  if (!json) return { needFollowup: false };
  const need = json.needFollowup === true;
  const q = String(json.question ?? "").trim();
  if (need && q) return { needFollowup: true, question: q };
  return { needFollowup: false };
}

/**
 * ストリーミング版の深掘り判定。
 * AIの「出力そのもの」で必要性を自動判定する（streamingオプション活用）:
 *   - 回答が十分なら、AIは先頭に `[OK]` だけを出力する → needFollowup:false
 *   - 不足なら、追加質問の本文をそのまま出力する → その差分を onDelta で逐次返す
 * 先頭トークンだけ見れば「掘る/掘らない」を判断できるので最速。
 * Gemini 未設定／失敗時は needFollowup:false。
 */
export async function streamFollowup(
  args: { questionLabel: string; answer: string },
  onDelta: (text: string) => void
): Promise<DeepenResult> {
  const answer = String(args.answer ?? "").trim();
  if (!answer) return { needFollowup: false };

  const prompt =
    "あなたは丁寧で簡潔な採用担当者です。ご応募者様への事前ご案内を行っています。\n" +
    "以下の「質問」と「ご応募者様の回答」を読み、選考を進めるうえで具体性が十分か判断してください。\n" +
    "・十分なら、最初に `[OK]` とだけ出力してください（他には何も書かない）。\n" +
    "・不足なら、より具体的な情報（実績・数字・役割・期間・背景など）をお伺いする追加質問を" +
    "1つだけ、丁寧な敬語で短く出力してください（前置き・記号・引用符・コードフェンスは付けない）。\n\n" +
    `質問: ${args.questionLabel}\n` +
    `ご応募者様の回答: ${answer}`;

  let buf = "";
  let decided: "ok" | "question" | null = null;
  let questionText = "";

  const emitQuestion = (s: string) => {
    if (!s) return;
    questionText += s;
    onDelta(s);
  };

  // ハーネス経由でストリーム。マーカー検出は onDelta の中で行う。
  const onDeltaMarker = (delta: string) => {
    if (decided === "ok") return; // 判定済み（十分）。残りは捨てる
    if (decided === "question") {
      emitQuestion(delta);
      return;
    }
    // --- 未判定：先頭が [OK] マーカーかどうかを見極める ---
    buf += delta;
    const trimmed = buf.trimStart();
    if (trimmed.length === 0) return;
    const upper = trimmed.toUpperCase();
    if (SUFFICIENT_MARK.startsWith(upper) && upper.length < SUFFICIENT_MARK.length) {
      return; // まだマーカーの途中かもしれない
    }
    if (upper.startsWith(SUFFICIENT_MARK)) {
      decided = "ok";
      return;
    }
    // マーカーではない → 追加質問の本文
    decided = "question";
    emitQuestion(buf);
    buf = "";
  };

  const r = await runStream("deepen", "deepen", prompt, onDeltaMarker, {
    maxOutputTokens: 120,
    temperature: 0.3,
    timeoutMs: DEEPEN_TIMEOUT_MS,
  });
  if (!r.ok) return { needFollowup: false };

  if (decided === "ok") return { needFollowup: false };
  if (decided === "question") {
    const q = questionText.trim();
    return q ? { needFollowup: true, question: q } : { needFollowup: false };
  }

  // 終了時もまだ未判定（極端に短い出力など）
  const leftover = buf.trim();
  if (!leftover) return { needFollowup: false };
  if (leftover.toUpperCase().startsWith(SUFFICIENT_MARK)) {
    return { needFollowup: false };
  }
  emitQuestion(buf);
  return { needFollowup: true, question: leftover };
}
