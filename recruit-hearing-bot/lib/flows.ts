// lib/flows.ts
// ヒアリングの「質問フロー定義」。
// ドメインは「IBMに入りたいか・自分に合っていそうか悩んでいる方の気持ちの整理」。
// 合否判定ではなく、相談者の内省を引き出すことが目的。

export type Slot = {
  /** 回答を保存するキー（answers[key]） */
  key: string;
  /** ユーザーに出す質問文 */
  label: string;
  /** AI深掘りの対象にするか（回答の十分さをAIが判定し、必要なら1回だけ掘る） */
  deepen?: boolean;
};

export type Flow = {
  id: string;
  title: string;
  /** 開始時のあいさつ */
  intro: string;
  slots: Slot[];
  /** 完了時の締め文 */
  outro: string;
};

export const RECRUIT_FLOW: Flow = {
  id: "recruit",
  title: "IBMで働くこと、一緒に考えるヒアリング",
  intro:
    "こんにちは。こちらは、IBMへの入社を迷っている方の気持ちを一緒に整理するためのヒアリングです。\n" +
    "合否を決めるものではありません。「IBMに入りたいか」「自分に合っていそうか」を考える手がかりを、対話しながら見つけていきましょう。\n" +
    "うまく言葉にできないことがあっても大丈夫です。そのままお伝えください。",
  slots: [
    {
      key: "name",
      label: "はじめに、お名前（ニックネームでも構いません）を教えてください。",
    },
    {
      key: "status",
      label:
        "いまのご状況を教えてください。（例：学生／社会人で転職を検討中／IBMの選考を受けるか迷っている など）",
    },
    {
      key: "trigger",
      label: "IBMが気になっているのは、どんなきっかけや理由からですか？",
      deepen: true,
    },
    {
      key: "values",
      label:
        "お仕事やキャリアで大切にしたいこと・実現したいことは何でしょうか？",
      deepen: true,
    },
    {
      key: "strengths",
      label:
        "ご自身の強みや、活かせそうな経験・スキルがあれば教えてください。",
      deepen: true,
    },
    {
      key: "concerns",
      label:
        "IBMに入ること、または「自分に合うか」について、不安や迷っている点はありますか？",
      deepen: true,
    },
    {
      key: "work_style",
      label:
        "希望する働き方があれば教えてください。（勤務地・リモート・チームの雰囲気・裁量 など）",
    },
    {
      key: "wrap",
      label:
        "最後に、ほかに整理したいモヤモヤや相談したいことがあれば、自由にどうぞ。（特になければ「特になし」）",
    },
  ],
  outro:
    "ありがとうございました。お話しいただいた内容を整理して、あなたがIBMで働くイメージを一緒に深められるよう、担当者がキャリア面談などでご案内します。\n" +
    "気持ちが変わったり、追加で相談したくなったら、いつでも画面下部の「最初から入力し直す」から始められます。",
};

const FLOWS: Record<string, Flow> = {
  [RECRUIT_FLOW.id]: RECRUIT_FLOW,
};

export const DEFAULT_FLOW_ID = RECRUIT_FLOW.id;

export function getFlow(id: string | null | undefined): Flow | null {
  if (!id) return null;
  return FLOWS[id] ?? null;
}
