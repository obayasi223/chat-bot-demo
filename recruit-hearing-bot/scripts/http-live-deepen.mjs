// ライブ検証：実Gemini で AI深掘りが動くか。
// 深掘り対象(experience)にわざと薄い回答 → 追加質問(💡)が生成されるかを見る。
const BASE = process.env.BASE || "http://localhost:3000";
let cookie = "";

function log(...a) { console.log(...a); }
function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exit(1); } console.log("✓", m); }

async function getState() {
  const res = await fetch(`${BASE}/api/hearing`, { headers: cookie ? { cookie } : {} });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const m = c.match(/(rhb_sid=[^;]+)/); if (m) cookie = m[1];
  }
  return res.json();
}
async function postTurn(text) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/hearing`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ text }),
  });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = "", streamed = "", done = null, deltas = 0;
  while (true) {
    const { value, done: rd } = await reader.read(); if (rd) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
    for (const p of parts) {
      const l = p.split("\n").find((x) => x.startsWith("data:")); if (!l) continue;
      const e = JSON.parse(l.slice(5).trim());
      if (e.type === "delta") { streamed += e.text; deltas++; }
      if (e.type === "done") done = e;
      if (e.type === "error") throw new Error(e.message);
    }
  }
  return { streamed, done, deltas, ms: Date.now() - t0 };
}

await getState();
await postTurn("田中花子");          // name
await postTurn("バックエンドエンジニア"); // role

log("\n--- experience に曖昧な回答を送る（深掘りを誘発）---");
const d = await postTurn("いろいろやってきました");
assert(d.done != null, "experienceターンが done で完結（ハングしない）");
log(`  elapsed=${d.ms}ms deltas=${d.deltas} pendingKey=${d.done.meta.pendingKey} currentKey=${d.done.meta.currentKey}`);
log(`  streamed= ${JSON.stringify(d.streamed.slice(0, 160))}`);

const askedFollowup = d.done.meta.pendingKey === "experience";
if (askedFollowup) {
  console.log("✓ 実Geminiが追加質問を生成した＝ライブAI深掘り成功");
  assert(d.deltas >= 2, "追加質問はトークン逐次（複数delta）でストリームされた");
  assert(d.done.meta.inFollowup === true, "深掘り中は inFollowup=true");
  log("\n--- 追加質問に回答 → 次スロットへ進むか ---");
  const d2 = await postTurn("Web受託で3年、Node.jsとReactで実装を担当していました");
  log(`  currentKey=${d2.done.meta.currentKey} inFollowup=${d2.done.meta.inFollowup}`);
  assert(d2.done.meta.currentKey === "skills", "追加質問に答えると skills へ進む");
  assert(d2.done.meta.inFollowup === false, "深掘り解消後 inFollowup=false");
  console.log("\n🎉 ライブAI深掘り：全通過");
} else {
  console.log("⚠ 追加質問が生成されませんでした。");
  console.log("  → Geminiが『十分』と判定した / もしくは到達不可（ネットワーク等）の可能性。");
  console.log(`  （elapsed=${d.ms}ms。極端に短い場合は到達不可の疑い）`);
  process.exit(2);
}
