// lib/handleText.ts
// 会話の中核ロジック。web_hearing の handleText.ts に相当（MVP向けに簡素化）。
// フロー(スロット)を順に尋ね、deepen対象は薄い回答のときだけAIで1回追加質問する。
import { getFlow, DEFAULT_FLOW_ID, type Flow, type Slot } from "./flows";
import { proposeFollowup, assessAnswer } from "./aiDeepen";
import { streamKnowledgeAnswer } from "./intent";
import { streamUnsureAssist } from "./assist";
import { classifyTurn, type Classification } from "./harness/classify";
import { FALLBACK_ANSWER } from "./knowledge";
import { computeCoverage, getAxisById, type Coverage } from "./coverage";
import { proposeGapQuestion } from "./gapfill";
import type { AnswerValue, State } from "./state";

export const RESET_COMMAND = "__reset__";
/** 「答えにくい・特になし」ボタン用：分類もAIも通さず、確実に次へ進める逃げ道 */
export const SKIP_COMMAND = "__skip__";
/** スキップ時に保存する回答値 */
const SKIP_ANSWER = "特になし";

/** 深掘りの上限往復数（これを超えたら十分性に関わらず前進） */
const MAX_DEEPEN_ROUNDS = Math.max(
  0,
  Number(process.env.AI_DEEPEN_MAX_ROUNDS ?? "2")
);

/**
 * 終盤に、手薄な観点を補う「開かれた質問」を出す上限回数。
 * 自由会話を固定質問だらけにしないため、少なめに抑える（0で無効）。
 */
const GAPFILL_MAX = Math.max(
  0,
  Number(process.env.AI_GAPFILL_MAX_QUESTIONS ?? "2")
);

/** ギャップ補完の回答へ返す軽い相づち（連発を避けて自然に） */
const GAP_ACKS = [
  "ありがとうございます。",
  "なるほど、ありがとうございます。",
  "承知しました。お話しいただき助かります。",
];
function pickGapAck(state: State): string {
  const i = Math.abs(state.gapfillAsked ?? 0) % GAP_ACKS.length;
  return GAP_ACKS[i];
}

/** AIがリフレクション（相づち）を返せなかったときの、追加質問の前置き */
const FOLLOWUP_PREFIX = "もう少しだけ、詳しくお聞かせください。\n\n";

/** 応募者からの質問に答えるときの冒頭文 */
const QUESTION_LEAD = "ご質問ありがとうございます。\n\n";
/** 回答に詰まっている（unsure）ときの補足文。確実な離脱はボタンへ誘導。 */
const CLARIFY_MESSAGE =
  "わかる範囲で問題ございません。お答えが難しい場合は、入力欄の下にある「答えにくい・特になし」ボタンを押していただくと、そのまま次へ進めます。";
/** 提案の後に添える、ボタン離脱の案内 */
const SKIP_HINT =
  "（それでもお答えが難しい場合は「答えにくい・特になし」ボタンで次へ進めます）";
/** 無関係（offtopic）入力への丁寧な引き戻し文 */
const OFFTOPIC_MESSAGE =
  "恐れ入りますが、こちらはIBMで働くことを一緒に考えるためのヒアリングです。" +
  FALLBACK_ANSWER;
/** 質問に答えたあと、元の質問へ戻すときの導入文（同じ言い回しの連発を避けて自然に） */
const REASK_LEADS = [
  "それでは、改めてお伺いします。",
  "ありがとうございます。先ほどの点に戻りますね。",
  "では、こちらもぜひお聞かせください。",
];
/** 完了後の案内 */
const DONE_HINT = "内容を修正される場合は、画面下部の「最初から入力し直す」を押してください。";

/** 連発を避けるため、スロット位置で決定的に言い回しを選ぶ（テストの再現性も保つ） */
function pickReask(state: State): string {
  const i = Math.abs(state.currentIndex) % REASK_LEADS.length;
  return REASK_LEADS[i];
}

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
  /** 「十分に取れた」と推定できた回答の数（深掘り対象のうち） */
  sufficientCount: number;
  /** 深掘り対象スロットの総数（十分性の母数） */
  deepenTotal: number;
  /** いまの深掘りラウンド（0=深掘りしていない） */
  deepenRound: number;
  /** 観点ごとの充足度・均等度（取れたデータから数式で算出。AI不使用） */
  coverage: Coverage;
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

  // 十分性のカウント（深掘り対象スロットを母数に「十分に取れた」数を数える）
  const deepenKeys = new Set((flow?.slots ?? []).filter((s) => s.deepen).map((s) => s.key));
  let sufficientCount = 0;
  for (const [key, a] of Object.entries(state.answers)) {
    if (deepenKeys.has(key) && a.sufficiency === "sufficient") sufficientCount++;
  }

  return {
    flowId: state.flowId,
    mode: state.mode,
    currentKey: state.pendingFollowup?.key ?? slot?.key ?? null,
    pendingKey: state.pendingFollowup?.key ?? null,
    answeredCount: answered,
    totalSlots: total,
    inFollowup: !!state.pendingFollowup,
    sufficientCount,
    deepenTotal: deepenKeys.size,
    deepenRound: state.pendingFollowup?.round ?? 0,
    // 取れたデータからの観点バランス計算（純粋関数・AI不使用＝ストリーミング後段で軽量に算出）
    coverage: computeCoverage(state, flow),
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
  name: "ありがとうございます。これから一緒に整理していきましょう",
  status: "今のご状況を伺いました。状況に合わせて一緒に考えていけます",
  trigger: "きっかけを伺いました。興味の源を一緒に深めていけます",
  values: "大切にしたい価値観を伺いました。IBMとの相性を考える軸になります",
  strengths: "強みを伺いました。IBMで活かせる場面をイメージしやすくなります",
  concerns: "不安な点を伺いました。これを一つずつ整理していけます",
  work_style: "希望する働き方を伺いました。実際の働き方と照らし合わせられます",
  wrap: "ありがとうございます。お話を担当者と共有し、面談でより深められます",
};

/**
 * 回答直後に冒頭へ添える「相づち（ack）」を組み立てる。
 * 進捗の残り数は画面上部の進捗バーで示すため、ここでは付けず自然な一言にする。
 */
function ackLine(answered: Slot | undefined): string {
  const gain = answered ? GAIN_BY_KEY[answered.key] : undefined;
  return gain ? gain : "ご回答ありがとうございます";
}

/** このスロットのこれまでのやりとり（回答＋深掘りQ&A）をAI判定用に整形する */
function slotTranscript(a: AnswerValue): string {
  const lines = [`回答: ${a.raw}`];
  for (const f of a.followups ?? []) {
    if (f.answer?.trim()) {
      lines.push(`追加質問「${f.question}」への回答: ${f.answer.trim()}`);
    }
  }
  return lines.join("\n");
}

/** フローを開始し、最初の質問文（あいさつ込み）を返す */
export function startFlow(state: State): string {
  const flow = getFlow(DEFAULT_FLOW_ID)!;
  state.flowId = flow.id;
  state.mode = "collecting";
  state.currentIndex = 0;
  state.answers = {};
  state.pendingFollowup = null;
  state.gapfillAsked = 0;
  const text = `${flow.intro}\n\n${renderQuestion(flow.slots[0])}`;
  state.lastBotText = text;
  return text;
}

/** これまでの回答ログを文脈用に箇条書き化する（提案生成のコンテキスト） */
function collectedContext(state: State, flow: Flow): string {
  const lines: string[] = [];
  for (const s of flow.slots) {
    const a = state.answers[s.key];
    const raw = a?.raw?.trim();
    if (!raw || raw === SKIP_ANSWER) continue;
    lines.push(`- ${s.label} → ${raw}`);
    for (const f of a?.followups ?? []) {
      if (f.answer?.trim()) lines.push(`  - ${f.question} → ${f.answer.trim()}`);
    }
  }
  return lines.join("\n");
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

/**
 * ストリーミング版: 次スロットへ進み「相づち＋次の質問」を emit する。
 * ack を渡すと相づち（GAIN文言/リフレクション）の代わりに使う。
 * AIが生成したリフレクション（相手の回答に触れた一言）を渡すと、より自然な会話になる。
 * 主要スロットを終えたら、いきなり締めず「観点ギャップの補完」を検討する。
 */
async function advanceAndAskStream(
  state: State,
  flow: Flow,
  emit: (delta: string) => void,
  ack?: string
): Promise<TurnResult> {
  const answered = flow.slots[state.currentIndex];
  state.currentIndex += 1;
  const head = ack?.trim() ? ack.trim() : ackLine(answered);

  if (state.currentIndex < flow.slots.length) {
    const next = flow.slots[state.currentIndex];
    const out = `${head}\n\n${renderQuestion(next)}`;
    state.lastBotText = out;
    emit(out);
    return { outText: out, meta: metaOf(state) };
  }

  // 主要スロット完了 → 終盤の観点ギャップ補完を検討
  return finishOrGapfillStream(state, flow, emit, head);
}

/** 会話を締める（サマリ＋締め文）。これ以上の補完はしない。 */
function doneStream(
  state: State,
  flow: Flow,
  emit: (delta: string) => void,
  head: string
): TurnResult {
  state.mode = "done";
  state.pendingFollowup = null;
  const out = `${head}\n\n${buildSummary(state, flow)}\n\n${flow.outro}`;
  state.lastBotText = out;
  emit(out);
  return { outText: out, meta: metaOf(state) };
}

/**
 * 終盤、手薄な観点があれば「開かれた質問」で1つだけ補い、無ければ締める。
 * - 自由会話を固定質問だらけにしないため、上限（GAPFILL_MAX）を設ける。
 * - すでに会話で語られている観点はAIが covered と判断 → 聞かずに次/締めへ。
 * - AI不可/失敗時はそのまま締める（無理に固定質問を足さない）。
 */
async function finishOrGapfillStream(
  state: State,
  flow: Flow,
  emit: (delta: string) => void,
  head: string
): Promise<TurnResult> {
  const asked = state.gapfillAsked ?? 0;
  if (asked < GAPFILL_MAX) {
    const cov = computeCoverage(state, flow);
    if (cov.gaps.length > 0) {
      // 最も手薄なギャップ観点を優先。スロットが実在するものに限る。
      const axisId =
        cov.weakestAxisId && cov.gaps.includes(cov.weakestAxisId)
          ? cov.weakestAxisId
          : cov.gaps[0];
      const axis = getAxisById(axisId);
      const slotKey = axis?.slots.find((k) =>
        flow.slots.some((s) => s.key === k)
      );
      if (axis && slotKey) {
        const gq = await proposeGapQuestion({
          axisLabel: axis.label,
          context: collectedContext(state, flow),
        });
        if (!gq.covered && gq.ask) {
          state.gapfillAsked = asked + 1;
          state.pendingFollowup = {
            key: slotKey,
            question: gq.ask,
            round: 0,
            kind: "gapfill",
          };
          const out = `${head}\n\n${gq.ask}`;
          state.lastBotText = out;
          emit(out);
          return { outText: out, meta: metaOf(state) };
        }
      }
    }
  }
  return doneStream(state, flow, emit, head);
}

/**
 * 深掘りの「もう一段聞く」共通処理。
 * リフレクション（相づち）があればそれを前置きに、無ければ定型の前置きで追加質問を出す。
 */
function askFollowupStream(
  state: State,
  key: string,
  reflect: string,
  question: string,
  round: number,
  emit: (delta: string) => void
): TurnResult {
  const head = reflect.trim() ? `${reflect.trim()}\n\n` : FOLLOWUP_PREFIX;
  const out = `${head}${question.trim()}`;
  state.pendingFollowup = { key, question: question.trim(), round };
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
  emit: (delta: string) => void,
  context: string
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
      // 会話ログを踏まえた提案を生成（できなければ定型文）
      let body = "";
      const r = await streamUnsureAssist(
        { currentQuestion, context },
        (d) => {
          body += d;
          emit(d);
        }
      );
      if (r.text && body) {
        emit(`\n\n${SKIP_HINT}`);
        return `${body}\n\n${SKIP_HINT}`;
      }
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
        emit,
        collectedContext(state, flow)
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

  // --- スキップ（「答えにくい・特になし」ボタン）: 分類もAIも通さず確実に次へ ---
  if (text === SKIP_COMMAND) {
    if (state.pendingFollowup) {
      const wasGap = state.pendingFollowup.kind === "gapfill";
      state.pendingFollowup = null;
      // ギャップ補完をスキップ → これ以上は補わずそのまま締める
      if (wasGap) return doneStream(state, flow, emit, "承知しました。");
      // 深掘りを打ち切って次のスロットへ（基本回答は保存済み）
      return advanceAndAskStream(state, flow, emit, "承知しました。");
    }
    const cur = flow.slots[state.currentIndex];
    if (cur) {
      state.answers[cur.key] = {
        raw: SKIP_ANSWER,
        questionText: cur.label,
        followups: [],
        sufficiency: "partial",
        createdAt: new Date().toISOString(),
      };
    }
    return advanceAndAskStream(state, flow, emit, "承知しました。");
  }

  // --- 深掘り回答中 ---
  if (state.pendingFollowup) {
    const pf = state.pendingFollowup;

    // 分類 → PROCEED 以外（質問/unsure/offtopic）なら答えて深掘り質問へ戻す（消費しない）
    const cls = await classifyTurn(pf.question, text);
    const handled = await handleByDirection(
      cls,
      pf.question,
      text,
      emit,
      collectedContext(state, flow)
    );
    if (handled != null) {
      const reAsk = `${pickReask(state)}\n${pf.question}`;
      emit(`\n\n${reAsk}`);
      const out = `${handled}\n\n${reAsk}`;
      state.lastBotText = out;
      return { outText: out, meta: metaOf(state) };
    }

    // --- 終盤のギャップ補完への回答 ---
    if (pf.kind === "gapfill") {
      const existing = state.answers[pf.key];
      if (existing) {
        existing.followups = existing.followups ?? [];
        existing.followups.push({ question: pf.question, answer: text });
        if (!existing.sufficiency || existing.sufficiency === "unknown") {
          existing.sufficiency = "partial";
        }
      } else {
        // その観点スロットが未回答だった → 本回答として記録
        state.answers[pf.key] = {
          raw: text,
          questionText: pf.question,
          followups: [],
          sufficiency: "partial",
          createdAt: new Date().toISOString(),
        };
      }
      state.pendingFollowup = null;
      // まだ手薄な観点があれば続けて補完（上限まで）。無ければ締める。
      return finishOrGapfillStream(state, flow, emit, pickGapAck(state));
    }

    // --- 通常の深掘りへの回答 ---
    const target = state.answers[pf.key];
    if (target) {
      target.followups = target.followups ?? [];
      target.followups.push({ question: pf.question, answer: text });

      // 追加回答も含めて再度「十分に取れたか」を推定し、足りなければもう一段掘る
      const assess = await assessAnswer({
        questionLabel: target.questionText,
        transcript: slotTranscript(target),
        round: pf.round,
        maxRounds: MAX_DEEPEN_ROUNDS,
      });
      if (!assess.enough && assess.question && pf.round < MAX_DEEPEN_ROUNDS) {
        return askFollowupStream(
          state,
          pf.key,
          assess.reflect,
          assess.question,
          pf.round + 1,
          emit
        );
      }
      target.sufficiency = assess.enough ? "sufficient" : "partial";
      state.pendingFollowup = null;
      return advanceAndAskStream(state, flow, emit, assess.reflect);
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
  const handled = await handleByDirection(
    cls,
    slot.label,
    text,
    emit,
    collectedContext(state, flow)
  );
  if (handled != null) {
    const reAsk = `${pickReask(state)}\n${slot.label}`;
    emit(`\n\n${reAsk}`);
    const out = `${handled}\n\n${reAsk}`;
    state.lastBotText = out;
    return { outText: out, meta: metaOf(state) };
  }

  // PROCEED：回答として保存（十分性は未判定で開始）
  const answer: AnswerValue = {
    raw: text,
    questionText: slot.label,
    followups: [],
    sufficiency: "unknown",
    createdAt: new Date().toISOString(),
  };
  state.answers[slot.key] = answer;

  // AI深掘り：deepen対象なら「情報が十分に取れたか」を推定し、足りなければ自然に掘る。
  // （タイムアウト・遮断・AI未設定はハーネス側で処理し、enough=true で確実に前進する）
  if (slot.deepen && MAX_DEEPEN_ROUNDS > 0) {
    const assess = await assessAnswer({
      questionLabel: slot.label,
      transcript: slotTranscript(answer),
      round: 0,
      maxRounds: MAX_DEEPEN_ROUNDS,
    });
    if (!assess.enough && assess.question) {
      return askFollowupStream(state, slot.key, assess.reflect, assess.question, 1, emit);
    }
    // 十分に取れた（または掘れない）→ 自然な相づちを添えて前進
    answer.sufficiency = assess.source === "ai" ? "sufficient" : "unknown";
    return advanceAndAskStream(state, flow, emit, assess.reflect);
  }

  // 非深掘りスロット → 定型の相づち＋次の質問
  return await advanceAndAskStream(state, flow, emit);
}

export { metaOf };
