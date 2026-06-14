// 会話フローの簡易スモークテスト（DB/Gemini不要）。
// GEMINI_API_KEY 未設定なので深掘りはスキップされ、固定フローのみ進む。
import { handleTurnStream, startFlow, RESET_COMMAND } from "../lib/handleText.ts";
import { blankState } from "../lib/state.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("❌ FAIL:", msg);
    process.exit(1);
  }
  console.log("✓", msg);
}

async function turn(state: any, text: string): Promise<string> {
  let streamed = "";
  const res = await handleTurnStream(state, text, (d) => (streamed += d));
  // emit された差分の合計と最終 outText が一致すること
  assert(streamed === res.outText, `delta合計==outText (input="${text.slice(0, 12)}")`);
  return res.outText;
}

const state: any = blankState();

// 開始
const intro = startFlow(state);
assert(intro.includes("IBM"), "introにあいさつが含まれる");
assert(state.mode === "collecting", "開始後 mode=collecting");
assert(state.currentIndex === 0, "開始後 index=0");

// 7問に順番に回答（個人情報は扱わない対話型フロー）
const answers = [
  "知人がIBMで働いていて、規模の大きな仕事に惹かれました",
  "先進的で堅実なイメージです。実際の働き方はあまり知りません",
  "社会に影響のある仕事に、長く腰を据えて取り組みたいです",
  "受託開発で5年、ReactとTypeScriptでSPAを設計・実装してきました",
  "大企業で自分の裁量が限られないか、少し不安に感じています",
  "リモート可で、チームで協力しながら進められると力を発揮できます",
  "社会に貢献しながら自分も成長し続けられること、が今の軸です",
];

let last = "";
for (let i = 0; i < answers.length; i++) {
  last = await turn(state, answers[i]);
}

assert(state.mode === "done", "全問回答で mode=done");
assert(last.includes("【ご回答内容】"), "最後にサマリが出る");
assert(last.includes("今の軸です"), "サマリに最後の回答が含まれる");
assert(Object.keys(state.answers).length === 7, "回答が7件保存される");

// 完了後にもう一度送ると完了案内
const afterDone = await turn(state, "こんにちは");
assert(afterDone.includes("完了"), "完了後は完了案内を返す");

// リセット
const afterReset = await turn(state, RESET_COMMAND);
assert(afterReset.includes("IBM"), "リセットでintroに戻る");
assert(state.currentIndex === 0 && state.mode === "collecting", "リセットで状態が初期化");

console.log("\n🎉 全テスト通過");
