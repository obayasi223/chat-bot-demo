// HTTP E2E スモーク：実際に起動中のサーバへ叩く（Supabase/Gemini 無し）。
// 検証: Cookieセッション / インメモリ永続化 / SSEストリーミング / フロー進行 / リロード復帰
const BASE = process.env.BASE || "http://localhost:3000";

let cookie = "";

function assert(cond, msg) {
  if (!cond) {
    console.error("❌ FAIL:", msg);
    process.exit(1);
  }
  console.log("✓", msg);
}

async function getState() {
  const res = await fetch(`${BASE}/api/hearing`, {
    headers: cookie ? { cookie } : {},
  });
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const c of sc) {
    const m = c.match(/(^|;\s*)(rhb_sid=[^;]+)/);
    if (m) cookie = m[2];
  }
  const json = await res.json();
  return { status: res.status, json };
}

async function postTurn(text) {
  const res = await fetch(`${BASE}/api/hearing`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ text }),
  });
  assert(
    (res.headers.get("content-type") || "").includes("text/event-stream"),
    `POST("${text.slice(0, 10)}") は SSE を返す`
  );

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let streamed = "";
  let done = null;
  while (true) {
    const { value, done: rdone } = await reader.read();
    if (rdone) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const evt = JSON.parse(line.slice(5).trim());
      if (evt.type === "delta") streamed += evt.text;
      else if (evt.type === "done") done = evt;
      else if (evt.type === "error") throw new Error("server error: " + evt.message);
    }
  }
  assert(done != null, `POST("${text.slice(0, 10)}") は done イベントで終わる`);
  return { streamed, done };
}

// ---- 1) 初回 GET：フロー開始 ----
let g = await getState();
assert(g.status === 200, "GET 200");
assert(cookie.startsWith("rhb_sid="), "セッションCookieが発行される");
assert(Array.isArray(g.json.messages) && g.json.messages.length === 1, "初期メッセージは1件（intro+Q1）");
assert(g.json.messages[0].content.includes("IBM"), "introが含まれる");
assert(g.json.meta.currentKey === "trigger", "最初の質問キーは trigger");

// ---- 2) 回答を進める（Geminiなし＝深掘りスキップ）----
let r = await postTurn("規模の大きな仕事に惹かれました");
assert(r.streamed === r.done.outText, "ストリーム差分の合計 == done.outText");
assert(r.done.meta.currentKey === "image", "trigger回答後の質問キーは image");
assert(r.streamed.includes("✓") || r.streamed.length > 0, "回答後に応答が出る");

r = await postTurn("先進的で堅実なイメージです");
assert(r.done.meta.currentKey === "values", "image回答後の質問キーは values");

// ---- 3) リロード復帰：GETで履歴が増えている＝インメモリ永続化が効いている ----
g = await getState();
assert(g.json.messages.length >= 5, `リロードで履歴が保持される（${g.json.messages.length}件）`);
assert(g.json.meta.currentKey === "values", "リロード後も現在キーが保たれる");

// ---- 4) 残りを全部回答して完了 ----
const rest = [
  "社会に影響のある仕事に長く取り組みたい",
  "React/TSで5年、SPAを設計・実装",
  "大企業で自分の裁量が限られないか不安です",
  "リモート可、チームで協力して進めたい",
  "社会貢献と自己成長を両立できること、が今の軸です",
];
let last;
for (const t of rest) last = await postTurn(t);
assert(last.done.meta.mode === "done", "全回答で mode=done");
assert(last.streamed.includes("【ご回答内容】"), "完了時にサマリが出る");
assert(last.streamed.includes("今の軸です"), "サマリに最後の回答が含まれる");

// ---- 5) リセット ----
r = await postTurn("__reset__");
assert(r.done.meta.currentKey === "trigger", "リセットで trigger に戻る");
assert(r.done.meta.mode === "collecting", "リセットで collecting に戻る");

console.log("\n🎉 HTTP E2E 全通過");
