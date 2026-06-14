// lib/coverage.ts
// 「どのベクトル（観点）についてもまんべんなく情報が取れているか」を数式で算出する。
// AIを使わない純粋関数なので、回答テキストのストリーミング後（クリティカルパス外）で
// 軽量に計算できる＝体感速度に影響しない（“バックグラウンド”的に扱える）。
//
// 観点（axis）ごとに 0..1 のスコアを出し、全体の「充足度」と「均等度」を計算する:
//   - score_a = clamp01( α·suff_a + (1−α)·len_a )           （取れ具合）
//       len_a  = chars_a / (chars_a + K)                     （文字量の飽和関数）
//       suff_a = sufficient:1 / partial:0.6                  （AIの十分性推定があれば加味）
//   - coverage = mean(score)                                 （全体の充足度）
//   - evenness = H / ln(n)   （Pielou の均等度。H=−Σ p·ln p, p=score/Σscore）
//   - balance  = 1 / (1 + CV) （CV=std/mean。参考指標）
//   - balanced = evenness ≥ E_min かつ min(score) ≥ gap      （まんべんなく取れているか）
import { getFlow, type Flow } from "./flows";
import type { AnswerValue, Sufficiency, State } from "./state";

/** 観点（ベクトル）の定義。1観点は1つ以上のスロットを束ねる。 */
export type AxisDef = {
  id: string;
  label: string;
  /** この観点を構成するスロットkey */
  slots: string[];
};

/** ヒアリングの分析軸。flows のスロットkeyに対応（存在するものだけ採点）。 */
export const COVERAGE_AXES: AxisDef[] = [
  { id: "motivation", label: "動機・きっかけ", slots: ["trigger"] },
  { id: "values", label: "価値観", slots: ["values"] },
  { id: "strengths", label: "強み・経験", slots: ["strengths"] },
  { id: "concerns", label: "不安・迷い", slots: ["concerns"] },
  { id: "work_style", label: "働き方", slots: ["work_style"] },
];

/** ID から観点定義を引く */
export function getAxisById(id: string | null | undefined): AxisDef | null {
  if (!id) return null;
  return COVERAGE_AXES.find((a) => a.id === id) ?? null;
}

export type AxisScore = {
  id: string;
  label: string;
  /** 0..1 の取れ具合 */
  score: number;
  /** 何らかの回答があるか */
  answered: boolean;
  /** その観点の十分性（深掘り対象のみ。無ければ "n/a"） */
  sufficiency: Sufficiency | "n/a";
  /** 収集した実質文字量（参考） */
  chars: number;
};

export type Coverage = {
  axes: AxisScore[];
  /** 全体の充足度（平均スコア）0..1 */
  coverage: number;
  /** 均等度（Pielou）0..1。1=完全に均等 */
  evenness: number;
  /** バランス指標 1/(1+CV) 0..1（参考） */
  balance: number;
  /** 最小・最大スコア */
  min: number;
  max: number;
  /** 最も手薄な観点ID（次に補うとよい） */
  weakestAxisId: string | null;
  /** しきい値未満の観点ID（取りこぼし候補） */
  gaps: string[];
  /** まんべんなく取れているか */
  balanced: boolean;
};

// --- チューニング可能なパラメータ（環境変数で上書き可） ---
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
/** 文字量スコアの飽和スケール（chars=K で 0.5） */
const LEN_SCALE = num("COVERAGE_LEN_SCALE", 60);
/** 十分性スコアの重み（0..1）。残りが文字量スコアの重み */
const SUFF_WEIGHT = Math.min(1, Math.max(0, num("COVERAGE_SUFF_WEIGHT", 0.6)));
/** これ未満を「取りこぼし（gap）」とみなすしきい値 */
const GAP_THRESHOLD = num("COVERAGE_GAP_THRESHOLD", 0.5);
/** 「均等」とみなす evenness の下限 */
const EVENNESS_MIN = num("COVERAGE_EVENNESS_MIN", 0.85);

/** 情報量の薄い定型回答（取れていない扱い） */
const NON_INFORMATIVE = new Set(["", "特になし", "特に無し", "なし", "無し", "未定"]);

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
function round(x: number, d = 3): number {
  const p = 10 ** d;
  return Math.round(x * p) / p;
}

/** 実質的な文字量（定型の「特になし」等は0としてカウント） */
function meaningfulLen(s: string | undefined): number {
  const t = String(s ?? "").trim();
  if (NON_INFORMATIVE.has(t)) return 0;
  return t.length;
}

function answerChars(a: AnswerValue | undefined): number {
  if (!a) return 0;
  let c = meaningfulLen(a.raw);
  for (const f of a.followups ?? []) c += meaningfulLen(f.answer);
  return c;
}

/** sufficiency → 0..1（partial は中間、unknown は length 主導にするため null） */
function suffToScore(s: Sufficiency | undefined): number | null {
  if (s === "sufficient") return 1;
  if (s === "partial") return 0.6;
  return null; // unknown / 未設定 → 文字量のみで評価
}

/** 1観点のスコアを算出する */
function scoreAxis(def: AxisDef, state: State): AxisScore {
  let chars = 0;
  let answered = false;
  let bestSuff: number | null = null;
  let suffLabel: Sufficiency | "n/a" = "n/a";

  for (const key of def.slots) {
    const a = state.answers[key];
    if (!a) continue;
    if (String(a.raw ?? "").trim()) answered = true;
    chars += answerChars(a);
    const ss = suffToScore(a.sufficiency);
    if (ss != null && (bestSuff == null || ss > bestSuff)) {
      bestSuff = ss;
      suffLabel = a.sufficiency as Sufficiency;
    }
  }

  const lenScore = chars / (chars + LEN_SCALE);
  let score: number;
  if (bestSuff != null) {
    score = clamp01(SUFF_WEIGHT * bestSuff + (1 - SUFF_WEIGHT) * lenScore);
  } else {
    score = lenScore;
  }
  if (!answered) score = 0;

  return {
    id: def.id,
    label: def.label,
    score: round(score),
    answered,
    sufficiency: suffLabel,
    chars,
  };
}

/**
 * 取れたデータから観点ごとの充足度と全体の均等度を計算する（純粋・同期・AI不使用）。
 * @param state 会話状態
 * @param flow  省略時は state.flowId から解決
 */
export function computeCoverage(state: State, flow?: Flow | null): Coverage {
  const f = flow ?? getFlow(state.flowId);
  const slotKeys = new Set((f?.slots ?? []).map((s) => s.key));

  // フローに存在するスロットを含む観点だけ採点する
  const defs = COVERAGE_AXES.map((d) => ({
    ...d,
    slots: d.slots.filter((k) => slotKeys.has(k)),
  })).filter((d) => d.slots.length > 0);

  const axes = defs.map((d) => scoreAxis(d, state));
  const n = axes.length;

  if (n === 0) {
    return {
      axes: [],
      coverage: 0,
      evenness: 0,
      balance: 0,
      min: 0,
      max: 0,
      weakestAxisId: null,
      gaps: [],
      balanced: false,
    };
  }

  const scores = axes.map((a) => a.score);
  const sum = scores.reduce((s, x) => s + x, 0);
  const mean = sum / n;
  const min = Math.min(...scores);
  const max = Math.max(...scores);

  // 均等度（Pielou's evenness）: H/ln(n)
  let evenness: number;
  if (n === 1) {
    evenness = mean > 0 ? 1 : 0;
  } else if (sum <= 0) {
    evenness = 0;
  } else {
    let H = 0;
    for (const x of scores) {
      if (x <= 0) continue;
      const p = x / sum;
      H += -p * Math.log(p);
    }
    evenness = H / Math.log(n);
  }

  // バランス指標: 1/(1+CV)
  const variance = scores.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  const cv = mean > 0 ? std / mean : 0;
  const balance = 1 / (1 + cv);

  // 最も手薄な観点・取りこぼし候補
  const weakest = axes.reduce((w, a) => (a.score < w.score ? a : w), axes[0]);
  const gaps = axes.filter((a) => a.score < GAP_THRESHOLD).map((a) => a.id);
  const balanced = evenness >= EVENNESS_MIN && min >= GAP_THRESHOLD;

  return {
    axes,
    coverage: round(mean),
    evenness: round(evenness),
    balance: round(balance),
    min: round(min),
    max: round(max),
    weakestAxisId: weakest.id,
    gaps,
    balanced,
  };
}
