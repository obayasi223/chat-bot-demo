// lib/flows.ts
// ヒアリングの「質問フロー定義」。
// ドメインは「IBMへの理解を深めながら、自分の“就活の軸”を一緒に言語化する対話」。
// 合否判定ではなく、対話を通じた相談者の内省・気づきを引き出すことが目的。
// 個人情報（氏名など）は扱わず、開かれた問いで対話性を強める。

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
  title: "IBM理解と就活の軸を深める対話",
  intro:
    "こんにちは。ここは、IBMについて理解を深めながら、あなたの『就活の軸』を一緒に言葉にしていく対話の場です。\n" +
    "合否を決めるものではありません。気になることがあれば、いつでも質問してください（仕事内容・働き方・選考など、分かる範囲でお答えします）。\n" +
    "答えがまとまっていなくても大丈夫。雑談するくらいの気持ちで、思いついたことからお話しください。",
  slots: [
    {
      key: "trigger",
      label:
        "まず伺いたいのですが、IBMやIBMでの仕事に興味を持ったのは、どんなきっかけや出来事からでしたか？",
      deepen: true,
    },
    {
      key: "image",
      label:
        "いまのIBMに対して、どんなイメージや期待を持っていますか？\n逆に「ここがよく分からない・もっと知りたい」という点があれば、それも遠慮なく教えてください（その場でお答えします）。",
      deepen: true,
    },
    {
      key: "values",
      label:
        "お仕事を選ぶうえで、大切にしたいこと・ここは譲れないと感じることは何ですか？（働く意味・成長・人との関わり・安定 など、ぼんやりでも大丈夫です）",
      deepen: true,
    },
    {
      key: "strengths",
      label:
        "これまで打ち込んできたことや、ご自身の強み・活かしたい経験があれば聞かせてください。",
      deepen: true,
    },
    {
      key: "concerns",
      label:
        "IBMや「自分に本当に合うのか」について、不安に感じることや、引っかかっている点はありますか？",
      deepen: true,
    },
    {
      key: "work_style",
      label:
        "どんな環境や働き方だと、自分らしく力を発揮できそうですか？（チームの雰囲気・裁量・リモート・スピード感 など）",
    },
    {
      key: "axis",
      label:
        "ここまでの対話を踏まえて、いまの『就活の軸』をひとことで言うとしたら、どんな言葉になりそうですか？\nまだ途中の感覚でも構いません。一緒に整えていきましょう。",
      deepen: true,
    },
  ],
  outro:
    "ありがとうございました。今日の対話で見えてきた『軸』や気づきを整理しました。\n" +
    "IBMへの理解も、就活の軸も、考えるほどに更新されていくものです。気持ちが動いたら、いつでも画面下部の「最初から入力し直す」から続きを考えられます。",
};

const FLOWS: Record<string, Flow> = {
  [RECRUIT_FLOW.id]: RECRUIT_FLOW,
};

export const DEFAULT_FLOW_ID = RECRUIT_FLOW.id;

export function getFlow(id: string | null | undefined): Flow | null {
  if (!id) return null;
  return FLOWS[id] ?? null;
}
