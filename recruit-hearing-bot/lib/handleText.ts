// lib/handleText.ts
// 会話の中核ロジック。web_hearing の handleText.ts に相当（MVP向けに簡素化）。
// フロー(スロット)を順に尋ね、deepen対象は薄い回答のときだけAIで1回追加質問する。
import { getFlow, DEFAULT_FLOW_ID, type Flow, type Slot } from "./flows";
import { proposeFollowup, streamFollowup } from "./aiDeepen";
import { streamKnowledgeAnswer } from "./intent";
import { classifyTurn, type Classification } from "./harness/classify";
import { FALLBACK_ANSWER } from "./knowledge";
import type { State } from "./state";

export const RESET_COMMAND = "__reset__";

/** 追加質問の冒頭に付ける案内文（お客様向け） */
const FOLLOWUP_PREFIX = "恐れ入ります。もう一点、詳しくお伺いさせてください。\n\n";

/** 応募者からの質問に答えるときの冒頭文 */
const QUESTION_LEAD = "ご質問ありがとうございます。\n\n";
/** 回答に詰まっている（unsure）ときの補足文 */
const CLARIFY_MESSAGE =
  "わかる範囲で問題ございません。該当が無ければ「特になし」とご入力いただければ、そのまま次へ進めます。";
/** 無関係（offtopic）入力への丁寧な引き戻し文 */
const OFFTOPIC_MESSAGE =
  "恐れ入りますが、こちらは採用エントリーのご入力フォームです。" + FALLBACK_ANSWER;
/** 質問に答えたあと、元の質問へ戻すときの導入文（IBM: return to flow） */
const REASK_LEAD = "それでは、改めてお伺いします。\n";
/** 完了後の案内 */
const DONE_HINT = "内容を修正される場合は、画面下部の「最初から入力し直す」を押してください。";

export type Meta = {
  flowId: string | null;
  mode: State["mode"];
  /** いま回答対象になっているスロットkey（通常質問 or 深掘り元） */
  currentKey: string | null;
  /** 深掘り待ちのkey（無ければ null） */
  pendingKey: string | null;
  /** 回答が完了した基本スロット数（進捗バー用） */
  answeredCount: number;
  /** 基本スロットの総数（進捗バー用） */
  totalSlots: number;
  /** いま深掘り質問に回答中か（基本スロットの途中で質問が増えている状態） */
  inFollowup: boolean;
};

export type TurnResult = {
  outText: string;
  meta: Meta;
};

function metaOf(state: State): Meta {
  const flow = getFlow(state.flowId);
  const total = flow?.slots.length ?? 0;
  const slot = flow?.slots[state.currentIndex] ?? null;
  // 完了済みの基本スロット数。深掘り中は currentIndex が進まないので、その質問は未完了扱い。
  const answered =
    state.mode === "done" ? total : Math.min(state.currentIndex, total);
  return {
    flowId: state.flowId,
    mode: state.mode,
    currentKey: state.pendingFollowup?.key ?? slot?.key ?? null,
    pendingKey: state.pendingFollowup?.key ?? null,
    answeredCount: answered,
    totalSlots: total,
    inFollowup: !!state.pendingFollowup,
  };
}

function renderQuestion(slot: Slot): string {
  return slot.label;
}

/**
 * 各スロットへの回答で「何が分かり・何ができるようになったか」を表す短い文。
 * 回答直後のbot応答の冒頭に添えて、進捗を実感してもらう。
 * （flows.ts には手を入れず、key で対応づけている）
 */
const GAIN_BY_KEY: Record<string, string> = {
  name: "お名前を承りました。担当者よりご連絡差し上げる際に使用いたします",
  role: "ご希望の職種を承りました。適した選考をご案内いたします",
  experience: "ご経験を承りました。より詳しいご案内の準備が整いました",
  skills: "お持ちのスキルを承りました。ご経験に合ったご案内が可能です",
  motivation: "志望動機を承りました。面接に向けた準備を進められます",
  conditions: "ご希望条件を承りました。条件に合う募集をご案内いたします",
  self_pr: "自己PRを承りました。あなたの強みを担当者にお伝えします",
};

/** 回答直後に冒頭へ添える「進捗ライン」を組み立てる */
function ackLine(answered: Slot | undefined, remaining: number): string {
  const gain = answered ? GAIN_BY_KEY[answered.key] : undefined;
  const head = gain ? gain : "ご回答ありがとうございます";
  return remaining > 0 ? `${head}（残り${remaining}問）` : head;
}

/** フローを開始し、最初の質問文（あいさつ込み）を返す */
export function startFlow(state: State): string {
  const flow = getFlow(DEFAULT_FLOW_ID)!;
  state.flowId = flow.id;
  state.mode = "collecting";
  state.currentIndex = 0;
  state.answers = {};
  state.pendingFollowup = null;
  const text = `${flow.intro}\n\n${renderQuestion(flow.slots[0])}`;
  state.lastBotText = text;
  return text;
}

/** 完了時のサマリを作る */
function buildSummary(state: State, flow: Flow): string {
  const lines: string[] = ["【ご回答内容】"];
  for (const slot of flow.slots) {
    const ans = state.answers[slot.key];
    const raw = ans?.raw?.trim() || "（未入力）";
    lines.push(`■ ${slot.label}\n${raw}`);
    for (const f of ans?.followups ?? []) {
      lines.push(`  └ ${f.question}\n     ${f.answer}`);
    }
  }
  return lines.join("\n\n");
}

/** 次のスロットへ進み、その質問文を返す。最後まで来たら完了処理して締め文を返す。 */
function advanceAndAsk(state: State, flow: Flow): string {
  state.currentIndex += 1;
  if (state.currentIndex < flow.slots.length) {
    const next = flow.slots[state.currentIndex];
    const text = renderQuestion(next);
    state.lastBotText = text;
    return text;
  }
  // 全スロット完了
  state.mode = "done";
  state.pendingFollowup = null;
  const text = `${buildSummary(state, flow)}\n\n${flow.outro}`;
  state.lastBotText = text;
  return text;
}

/**
 * 1ターン処理する。state はインプレースで更新される（呼び出し側で saveState すること）。
 */
export async function handleTurn(state: State, incoming: string): Promise<TurnResult> {
  const text = String(incoming ?? "").trim();

  // --- リセット ---
  if (text === RESET_COMMAND) {
    const out = startFlow(state);
    return { outText: out, meta: metaOf(state) };
  }

  // --- 未開始なら開始（通常はGET側で開始済み） ---
  if (!state.flowId || state.mode === "idle") {
    const out = startFlow(state);
    return { outText: out, meta: metaOf(state) };
  }

  const flow = getFlow(state.flowId);
  if (!flow) {
    const out = startFlow(state);
    return { outText: out, meta: metaOf(state) };
  }

  // --- 完了後 ---
  if (state.mode === "done") {
    const out =
      "ご入力は完了しております。内容を修正される場合は、画面下部の「最初から入力し直す」を押してください。";
    state.lastBotText = out;
    return { outText: out, meta: metaOf(state) };
  }

  // --- 深掘り回答中（pendingFollowup あり） ---
  if (state.pendingFollowup) {
    const pf = state.pendingFollowup;
    const target = state.answers[pf.key];
    if (target) {
      target.followups = target.followups ?? [];
      target.followups.push({ question: pf.question, answer: text });
    }
    state.pendingFollowup = null;
    // MVPは深掘り1回まで → そのまま次のスロットへ
    const out = advanceAndAsk(state, flow);
    return { outText: out, meta: metaOf(state) };
  }

  // --- 通常の回答（currentIndex のスロット） ---
  const slot = flow.slots[state.currentIndex];
  if (!slot) {
    // index異常 → 完了扱い
    state.mode = "done";
    const out = `${buildSummary(state, flow)}\n\n${flow.outro}`;
    state.lastBotText = out;
    return { outText: out, meta: metaOf(state) };
  }

  // 回答を保存
  state.answers[slot.key] = {
    raw: text,
    questionText: slot.label,
    followups: [],
    createdAt: new Date().toISOString(),
  };

  // AI深掘り：deepen対象なら、回答内容の十分さをAIが判定し必要なら1回だけ掘る
  if (slot.deepen) {
    const d = await proposeFollowup({ questionLabel: slot.label, answer: text });
    if (d.needFollowup && d.question) {
      const full = `${FOLLOWUP_PREFIX}${d.question}`;
      state.pendingFollowup = { key: slot.key, question: d.question, round: 1 };
      state.lastBotText = full;
      return { outText: full, meta: metaOf(state) };
    }
  }

  // 深掘り不要 → 次へ
  const out = advanceAndAsk(state, flow);
  return { outText: out, meta: metaOf(state) };
}

/** ストリーミング版: 次スロットへ進み「進捗ライン＋次の質問」を emit する */
function advanceAndAskStream(
  state: State,
  flow: Flow,
  emit: (delta: string) => void
): TurnResult {
  const answered = flow.slots[state.currentIndex];
  state.currentIndex += 1;

  if (state.currentIndex < flow.slots.length) {
    const next = flow.slots[state.currentIndex];
    const remaining = flow.slots.length - state.currentIndex;
    const out = `${ackLine(answered, remaining)}\n\n${renderQuestion(next)}`;
    state.lastBotText = out;
    emit(out);
    return { outText: out, meta: metaOf(state) };
  }

  // 全スロット完了
  state.mode = "done";
  state.pendingFollowup = null;
  const out = `${ackLine(answered, 0)}\n\n${buildSummary(state, flow)}\n\n${flow.outro}`;
  state.lastBotText = out;
  emit(out);
  return { outText: out, meta: metaOf(state) };
}

/**
 * PROCEED 以外の方向（質問・unsure・offtopic）を処理し、emit した全文を返す。
 * PROCEED の場合は null を返す（呼び出し側が通常処理を続行）。
 */
async function handleByDirection(
  classification: Classification,
  currentQuestion: string,
  text: string,
  emit: (delta: string) => void
): Promise<string | null> {
  switch (classification.direction) {
    case "PROCEED":
      return null;

    case "ANSWER_QUESTION": {
      // ナレッジ参照で回答（FAQ即時 → AIストリーム → フォールバック）
      emit(QUESTION_LEAD);
      let body = "";
      const ans = await streamKnowledgeAnswer(
        { currentQuestion, userText: text },
        (d) => {
          body += d;
          emit(d);
        }
      );
      return `${QUESTION_LEAD}${body || ans.text}`;
    }

    case "CLARIFY": {
      emit(CLARIFY_MESSAGE);
      return CLARIFY_MESSAGE;
    }

    case "FALLBACK": {
      emit(OFFTOPIC_MESSAGE);
      return OFFTOPIC_MESSAGE;
    }
  }
}

/**
 * 1ターンをストリーミングで処理する。
 * - 確定文（質問・まとめ・進捗ライン）は即座にまとめて emit（待ち時間ゼロ）
 * - AI深掘りが必要な場面だけ、AIの出力を逐次 emit（最初のトークンが出た瞬間に表示）
 * - 応募者からの質問（脱線）はその場で答えてから元の質問へ戻す（IBM: return to flow）
 * state はインプレースで更新される（呼び出し側で saveState すること）。
 */
export async function handleTurnStream(
  state: State,
  incoming: string,
  emit: (delta: string) => void
): Promise<TurnResult> {
  const text = String(incoming ?? "").trim();

  // --- リセット ---
  if (text === RESET_COMMAND) {
    const out = startFlow(state);
    emit(out);
    return { outText: out, meta: metaOf(state) };
  }

  // --- 未開始なら開始 ---
  if (!state.flowId || state.mode === "idle") {
    const out = startFlow(state);
    emit(out);
    return { outText: out, meta: metaOf(state) };
  }

  const flow = getFlow(state.flowId);
  if (!flow) {
    const out = startFlow(state);
    emit(out);
    return { outText: out, meta: metaOf(state) };
  }

  // --- 完了後 ---
  if (state.mode === "done") {
    // 完了後でも質問・相談には答える
    const cls = await classifyTurn("（ご入力は完了しています）", text);
    if (cls.direction === "ANSWER_QUESTION" || cls.direction === "FALLBACK") {
      const body = await handleByDirection(
        cls,
        "（ご入力は完了しています）",
        text,
        emit
      );
      emit(`\n\n${DONE_HINT}`);
      const out = `${body}\n\n${DONE_HINT}`;
      state.lastBotText = out;
      return { outText: out, meta: metaOf(state) };
    }
    const out = `ご入力は完了しております。${DONE_HINT}`;
    state.lastBotText = out;
    emit(out);
    return { outText: out, meta: metaOf(state) };
  }

  // --- 深掘り回答中 ---
  if (state.pendingFollowup) {
    const pf = state.pendingFollowup;

    // 分類 → PROCEED 以外（質問/unsure/offtopic）なら答えて深掘り質問へ戻す（消費しない）
    const cls = await classifyTurn(pf.question, text);
    const handled = await handleByDirection(cls, pf.question, text, emit);
    if (handled != null) {
      const reAsk = `${REASK_LEAD}${pf.question}`;
      emit(`\n\n${reAsk}`);
      const out = `${handled}\n\n${reAsk}`;
      state.lastBotText = out;
      return { outText: out, meta: metaOf(state) };
    }

    const target = state.answers[pf.key];
    if (target) {
      target.followups = target.followups ?? [];
      target.followups.push({ question: pf.question, answer: text });
    }
    state.pendingFollowup = null;
    return advanceAndAskStream(state, flow, emit);
  }

  // --- 通常の回答 ---
  const slot = flow.slots[state.currentIndex];
  if (!slot) {
    state.mode = "done";
    const out = `${buildSummary(state, flow)}\n\n${flow.outro}`;
    state.lastBotText = out;
    emit(out);
    return { outText: out, meta: metaOf(state) };
  }

  // 分類 → PROCEED 以外なら答えてから、同じ質問へ戻す（保存・前進しない）
  const cls = await classifyTurn(slot.label, text);
  const handled = await handleByDirection(cls, slot.label, text, emit);
  if (handled != null) {
    const reAsk = `${REASK_LEAD}${slot.label}`;
    emit(`\n\n${reAsk}`);
    const out = `${handled}\n\n${reAsk}`;
    state.lastBotText = out;
    return { outText: out, meta: metaOf(state) };
  }

  // PROCEED：回答として保存
  state.answers[slot.key] = {
    raw: text,
    questionText: slot.label,
    followups: [],
    createdAt: new Date().toISOString(),
  };

  // AI深掘り：deepen対象なら、AI出力そのもので必要性を自動判定し、必要なら逐次ストリーム
  // （タイムアウト・遮断はハーネス側で処理。詰まってもSSEは止めず次の質問へ進む）
  if (slot.deepen) {
    let started = false;
    const onDelta = (qDelta: string) => {
      if (!started) {
        emit(FOLLOWUP_PREFIX);
        started = true;
      }
      emit(qDelta);
    };
    const d = await streamFollowup(
      { questionLabel: slot.label, answer: text },
      onDelta
    );
    if (d.needFollowup && d.question) {
      const full = `${FOLLOWUP_PREFIX}${d.question}`;
      if (!started) emit(full);
      state.pendingFollowup = { key: slot.key, question: d.question, round: 1 };
      state.lastBotText = full;
      return { outText: full, meta: metaOf(state) };
    }
    // 深掘り無し時：途中まで案内文を出していたら改行で区切る
    if (started) emit("\n\n");
  }

  // 深掘り不要 → 進捗ライン＋次の質問
  return advanceAndAskStream(state, flow, emit);
}

export { metaOf };
