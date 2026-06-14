// lib/knowledge.ts
// チャットボットのナレッジ（よくある質問＝FAQ）と回答ポリシー。
// IBM watsonx Assistant の考え方を参考に、ヒアリング中に応募者から来る
// 「脱線（digression）」＝質問へ柔軟に答えるための知識ベース。
//   - 該当があれば FAQ で回答 → 元の質問へ戻る（return to flow）
//   - 該当が無ければ無理に答えず、担当者へ引き継ぐ（irrelevance/fallback）
// ※ 文言・内容は自社用にカスタマイズしてください（プレースホルダです）。

export const ASSISTANT_PERSONA =
  "あなたは「採用エントリー 事前ご案内」を担当する、丁寧で簡潔な採用アシスタントです。";

export type FaqEntry = {
  id: string;
  /** オフライン簡易マッチ用のキーワード */
  keywords: string[];
  /** 想定質問（プロンプト提示用） */
  q: string;
  /** 回答 */
  a: string;
};

export const FAQ: FaqEntry[] = [
  {
    id: "flow",
    keywords: ["流れ", "選考", "ステップ", "面接", "次", "プロセス", "この後", "今後", "結果"],
    q: "選考の流れを教えてほしい",
    a: "ご入力いただいた内容を担当者が確認し、追って選考のご案内（面談日程など）をメールでご連絡いたします。",
  },
  {
    id: "time",
    keywords: ["時間", "どれくらい", "所要", "かかる", "長い", "何分", "ボリューム"],
    q: "入力にどれくらい時間がかかる？",
    a: "ご入力は数分程度で完了します。途中で中断されても、同じ端末から再開できますのでご安心ください。",
  },
  {
    id: "privacy",
    keywords: ["個人情報", "プライバシー", "データ", "利用", "目的", "第三者", "保護", "安全", "管理"],
    q: "入力した情報はどう使われる？",
    a: "ご入力内容は本選考のご連絡・選考判断の目的のみに使用し、適切に管理いたします。目的外の利用や、許可なく第三者へ提供することはありません。",
  },
  {
    id: "edit",
    keywords: ["修正", "間違", "訂正", "やり直し", "変更", "消し", "戻る", "書き直"],
    q: "回答を修正したい",
    a: "画面下部の「最初から入力し直す」を押すと、最初からご入力いただけます。一部だけ補足したい場合は、そのまま続けてご記入のうえ、自己PR欄などで補足してください。",
  },
  {
    id: "save",
    keywords: ["保存", "中断", "あとで", "途中", "再開", "続き", "閉じ"],
    q: "途中で中断できる？",
    a: "はい。ご入力内容は自動的に保存されます。同じ端末・ブラウザから再度アクセスいただくと、続きから再開できます。",
  },
  {
    id: "optional",
    keywords: ["必須", "任意", "スキップ", "わからない", "ない", "空欄", "答えたくない"],
    q: "答えられない項目がある",
    a: "わかる範囲で問題ございません。該当がない項目は「特になし」とご入力いただければ、そのまま次へ進めます。",
  },
  {
    id: "contact",
    keywords: ["連絡", "問い合わせ", "電話", "メール", "担当", "人事", "直接", "聞きたい"],
    q: "担当者に直接連絡したい",
    a: "個別のお問い合わせは、採用ご担当者までご連絡ください。本フォームのご入力後でも承ります。",
  },
];

/** ナレッジに無い質問への定型フォールバック（無理に答えない） */
export const FALLBACK_ANSWER =
  "申し訳ございません。その点はこの場ではお答えしかねます。採用担当者より追ってご回答いたしますので、差し支えなければこのままご入力を続けてください。";

/** オフライン（Gemini未設定）時の簡易キーワードマッチ。最も一致数の多いFAQ回答を返す。 */
export function findFaqAnswer(text: string): string | null {
  const t = String(text ?? "").toLowerCase();
  if (!t) return null;
  let best: { score: number; a: string } | null = null;
  for (const e of FAQ) {
    let score = 0;
    for (const k of e.keywords) {
      if (t.includes(k.toLowerCase())) score++;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { score, a: e.a };
    }
  }
  return best?.a ?? null;
}

/** AIプロンプトに差し込む用のナレッジ文字列。 */
export function knowledgeForPrompt(): string {
  return FAQ.map((e) => `Q: ${e.q}\nA: ${e.a}`).join("\n\n");
}
