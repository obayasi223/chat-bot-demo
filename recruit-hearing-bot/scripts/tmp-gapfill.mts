import { handleTurnStream, startFlow } from "../lib/handleText.ts";
import { blankState } from "../lib/state.ts";

function ans(raw: string, sufficiency?: any) {
  return { raw, questionText: "", followups: [], sufficiency, createdAt: new Date().toISOString() };
}

async function turn(state: any, text: string) {
  let s = "";
  const res = await handleTurnStream(state, text, (d) => (s += d));
  console.log(`\n=== USER: ${text}`);
  console.log(res.outText);
  console.log("[meta] gaps:", res.meta.coverage.gaps, "| balanced:", res.meta.coverage.balanced, "| cov:", res.meta.coverage.coverage);
  return res;
}

const state: any = blankState();
startFlow(state);
// 主要スロットを事前に埋める（動機・不安は充実、価値観/強み/働き方は手薄）
state.answers = {
  name: ans("山田"),
  status: ans("社会人で転職を検討中です"),
  trigger: ans("大学でWatsonのAPIを使い、社会課題に大規模AIで挑む姿勢に強く共感しました。", "sufficient"),
  values: ans("成長したい", "partial"),
  strengths: ans("特になし"),
  concerns: ans("大企業で裁量が限られないか不安です。どの程度任せてもらえるか気になります。", "sufficient"),
  work_style: ans("リモート希望"),
};
state.currentIndex = 7; // wrap スロット
state.gapfillAsked = 0;

await turn(state, "特になし"); // wrap回答 → 終盤ギャップ補完が走るはず
await turn(state, "前職では小さなチームのリーダーを任され、調整役が得意でした。");
await turn(state, "落ち着いて取り組める環境だと力を発揮できます。");
console.log("\nmode:", state.mode, "| gapfillAsked:", state.gapfillAsked);
