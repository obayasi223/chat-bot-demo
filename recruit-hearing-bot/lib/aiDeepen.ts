// lib/aiDeepen.ts
// AI深掘り：回答から「情報が十分に取れたか」を推定し、足りなければ自然な追加質問を作る。
// 速度より「推測の確かさ」と「自然さ」を優先し、構造化JSONで一度に判定する:
//   - enough  : 本人を理解するのに十分か（= 十分性の推測結果）
//   - reflect : 相手の回答に触れた短い相づち・共感（自然な質疑のための“傾聴”）
//   - ask     : 不足時の追加質問（reflect を踏まえた具体的な問い）
// AI呼び出しは harness（サーキット＋タイムアウト＋テレメトリ）経由に統一。
import { runText, aiReady } from "./harness/aiRuntime";
import { ASSISTANT_PERSONA } from "./knowledge";

const DEEPEN_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_DEEPEN_MS ?? "12000");
const WRAPUP_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_WRAPUP_MS ?? "8000");

/** 回答の十分さ判定＋自然な反応の生成結果 */
export type AssessResult = {
  /** 本人を理解するのに十分な情報が取れたか（= 十分性の推測） */
  enough: boolean;
  /** 相手の回答に触れた短い相づち・共感（無ければ空文字） */
  reflect: string;
  /** 不足時の追加質問（enough=true なら空文字） */
  question: string;
  /** どこで判定したか（テレメトリ用） */
  source: "ai" | "fallback";
};

/** ```json ... ``` などを剥がして最初のJSONオブジェクトを取り出す */
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
 * 1スロット分のやりとりを読み、情報が十分に取れたかを推定する。
 * - AI未設定／失敗時は { enough:true, source:"fallback" }（=固定フローで前進）。
 *   ※ 無理に掘らず、確実に会話を進めることを優先する。
 *
 * @param questionLabel いま尋ねている問い
 * @param transcript    このスロットのこれまでのやりとり（回答＋深掘りQ&A）
 * @param round         すでに出した深掘り質問の回数（0始まり）
 * @param maxRounds     深掘りの上限回数
 */
export async function assessAnswer(args: {
  questionLabel: string;
  transcript: string;
  round: number;
  maxRounds: number;
}): Promise<AssessResult> {
  const transcript = String(args.transcript ?? "").trim();
  if (!transcript) {
    return { enough: true, reflect: "", question: "", source: "fallback" };
  }

  const remaining = Math.max(0, args.maxRounds - args.round);
  // 上限に達していたら、これ以上は掘らない方針をAIにも伝える。
  const depthHint =
    remaining <= 0
      ? "すでに十分に伺っています。これ以上は掘り下げず、必ず enough=true としてください。"
      : `深掘りはあと${remaining}回までです。十分に語られていれば無理に掘らず enough=true としてください。`;

  const prompt =
    ASSISTANT_PERSONA +
    "\n" +
    "以下は、IBMへの入社を迷っている方へのヒアリングの一場面です。\n" +
    "「問い」と「これまでのやりとり」を読み、相談者ご本人の考え・気持ち・背景が、" +
    "その方を理解するうえで十分に具体的に語られているかを判断してください。\n" +
    "具体的な経験・理由・気持ちが一つでも語られていれば、基本は enough=true としてください。" +
    "enough=false にするのは、回答が明らかに曖昧・ごく短い・抽象的で、ほとんど中身が読み取れない場合に限ります。\n" +
    depthHint +
    "\n" +
    "不足している場合は、これまでの内容に触れながら、もう一歩だけ自然に掘り下げる" +
    "追加質問を1つ作ってください（決めつけず、寄り添う敬語で）。\n\n" +
    `問い: ${args.questionLabel}\n` +
    "これまでのやりとり:\n" +
    transcript +
    "\n\n" +
    "次の JSON 形式【のみ】で答えてください（前後に説明文やコードフェンスを付けない）:\n" +
    '{"enough": true または false, ' +
    '"reflect": "相手の回答に触れた短い相づち・共感（1文・敬語）", ' +
    '"ask": "追加質問。enoughがtrueなら空文字"}';

  const r = await runText("deepen", "deepen", prompt, {
    maxOutputTokens: 240,
    temperature: 0.4,
    thinkingBudget: 0, // 思考オフ＝最速
    timeoutMs: DEEPEN_TIMEOUT_MS,
  });
  if (!r.ok) return { enough: true, reflect: "", question: "", source: "fallback" };

  const json = parseJsonLoose(r.value);
  if (!json) return { enough: true, reflect: "", question: "", source: "fallback" };

  const enough = json.enough === true;
  const reflect = String(json.reflect ?? "").trim();
  const question = String(json.ask ?? "").trim();

  // 上限到達後は掘らない／enough=false なのに質問が空なら掘れないので前進。
  if (remaining <= 0) return { enough: true, reflect, question: "", source: "ai" };
  if (!enough && !question) return { enough: true, reflect, question: "", source: "ai" };

  return { enough, reflect, question, source: "ai" };
}

/** 会話全体の十分性判定（AI主導の早期ラップアップ用） */
export type OverallAssess = {
  /** 相談者を理解するのに、全体として十分な情報が取れたか */
  done: boolean;
  /** 締めるときの一言（任意。無ければ空文字） */
  note: string;
  source: "ai" | "fallback";
};

/**
 * これまでの会話全体を読み、「もう十分に伺えたか（=ここで締めてよいか）」をAIが判断する。
 * - 残りの予定質問があっても、本人理解に十分なら done=true（=継続せず締めへ分岐）。
 * - AI不可/失敗時は done=false（=安全側。フローを続ける）。
 *
 * @param context  これまでの回答ログ（collectedContext）
 * @param remaining まだ尋ねていない主要質問のラベル一覧
 */
export async function assessOverall(args: {
  context: string;
  remaining: string[];
}): Promise<OverallAssess> {
  // AIが使えないなら早期終了は判断できない → 続行（安全側）。
  if (!aiReady("deepen")) return { done: false, note: "", source: "fallback" };

  const remaining = (args.remaining ?? []).filter(Boolean);
  const remainingText =
    remaining.length > 0 ? remaining.map((r) => `・${r}`).join("\n") : "（なし）";

  const prompt =
    ASSISTANT_PERSONA +
    "\n" +
    "これはIBMへの入社を迷っている方へのヒアリングです。これまでの会話を読み、" +
    "相談者ご本人（動機・価値観・強み・不安・働き方など）を理解するのに、" +
    "全体として十分な情報がすでに得られているかを判断してください。\n" +
    "十分であれば、まだ予定している質問が残っていても、ここで自然に締めて構いません（done=true）。\n" +
    "重要な観点がまだ語られておらず、続けて伺うべき場合は done=false にしてください。\n\n" +
    "まだ尋ねていない主要質問:\n" +
    remainingText +
    "\n\nこれまでの会話:\n" +
    (args.context || "（まだほとんどありません）") +
    "\n\n" +
    "次の JSON 形式【のみ】で答えてください（前後に説明文やコードフェンスを付けない）:\n" +
    '{"done": true または false, "note": "締める場合の自然な一言。続ける場合は空文字"}';

  const r = await runText("deepen", "deepen", prompt, {
    maxOutputTokens: 120,
    temperature: 0.3,
    thinkingBudget: 0,
    timeoutMs: WRAPUP_TIMEOUT_MS,
  });
  if (!r.ok) return { done: false, note: "", source: "fallback" };

  const json = parseJsonLoose(r.value);
  if (!json) return { done: false, note: "", source: "fallback" };

  return {
    done: json.done === true,
    note: String(json.note ?? "").trim(),
    source: "ai",
  };
}

// --- 以下は非ストリーム版 handleTurn（レガシー）用の簡易判定 ---

export type DeepenResult = {
  needFollowup: boolean;
  question?: string;
};

/**
 * レガシー（handleTurn）向け：assessAnswer をラップして従来の戻り値に合わせる。
 */
export async function proposeFollowup(args: {
  questionLabel: string;
  answer: string;
}): Promise<DeepenResult> {
  const answer = String(args.answer ?? "").trim();
  if (!answer) return { needFollowup: false };
  const a = await assessAnswer({
    questionLabel: args.questionLabel,
    transcript: `回答: ${answer}`,
    round: 0,
    maxRounds: 1,
  });
  if (!a.enough && a.question) return { needFollowup: true, question: a.question };
  return { needFollowup: false };
}
