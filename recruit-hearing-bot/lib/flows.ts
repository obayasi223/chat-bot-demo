// lib/flows.ts
// ヒアリングの「質問フロー定義」。web_hearing の lib/flows.ts に相当（構造を簡素化）。
// ドメインは「採用エントリーの事前ヒアリング」。

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
  title: "採用エントリー 事前ご案内",
  intro:
    "この度はご応募いただき、誠にありがとうございます。\n" +
    "選考を進めるにあたり、いくつかご質問させていただきます。\n" +
    "画面の案内に沿って、順番にご回答ください。",
  slots: [
    {
      key: "name",
      label: "はじめに、お名前をフルネームでご入力ください。",
    },
    {
      key: "role",
      label:
        "ご希望の職種をお教えください。（例：フロントエンドエンジニア、営業、デザイナー など）",
    },
    {
      key: "experience",
      label:
        "これまでのご経験についてお教えください。職種・年数・主な業務内容など、わかる範囲で結構です。",
      deepen: true,
    },
    {
      key: "skills",
      label: "お持ちのスキルや、ご使用になれる技術・ツールをお教えください。",
      deepen: true,
    },
    {
      key: "motivation",
      label:
        "志望動機をお聞かせください。なぜこの職種・当社にご興味をお持ちになったのか、お教えください。",
      deepen: true,
    },
    {
      key: "conditions",
      label:
        "ご希望条件をお教えください。（勤務地・働き方・希望年収・入社可能時期 など）",
    },
    {
      key: "self_pr",
      label:
        "最後に、自己PRや補足事項がございましたら、自由にご記入ください。（特にない場合は「特になし」とご入力ください）",
    },
  ],
  outro:
    "以上でご入力は完了です。貴重なお時間をいただき、誠にありがとうございました。\n" +
    "内容を確認のうえ、担当者よりご連絡いたします。\n" +
    "入力内容を修正される場合は、画面下部の「最初から入力し直す」を押してください。",
};

const FLOWS: Record<string, Flow> = {
  [RECRUIT_FLOW.id]: RECRUIT_FLOW,
};

export const DEFAULT_FLOW_ID = RECRUIT_FLOW.id;

export function getFlow(id: string | null | undefined): Flow | null {
  if (!id) return null;
  return FLOWS[id] ?? null;
}
