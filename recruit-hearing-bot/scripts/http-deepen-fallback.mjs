// Geminiが「設定されているが失敗する」状況で、ストリームがハングせず次へ進むことを検証。
const BASE = process.env.BASE || "http://localhost:3000";
let cookie = "";

function assert(c, m) { if (!c) { console.error("❌ FAIL:", m); process.exit(1); } console.log("✓", m); }

async function getState() {
  const res = await fetch(`${BASE}/api/hearing`, { headers: cookie ? { cookie } : {} });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const m = c.match(/(rhb_sid=[^;]+)/); if (m) cookie = m[1];
  }
  return res.json();
}
async function postTurn(text) {
  const res = await fetch(`${BASE}/api/hearing`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ text }),
  });
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let buf = "", done = null;
  while (true) {
    const { value, done: rd } = await reader.read(); if (rd) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n"); buf = parts.pop() ?? "";
    for (const p of parts) {
      const l = p.split("\n").find((x) => x.startsWith("data:")); if (!l) continue;
      const e = JSON.parse(l.slice(5).trim());
      if (e.type === "done") done = e;
      if (e.type === "error") throw new Error(e.message);
    }
  }
  return done;
}

await getState();
await postTurn("山田太郎");        // name
await postTurn("エンジニア");       // role
const t0 = Date.now();
const d = await postTurn("受託で5年、React/TSでSPA設計"); // experience（deepen対象）
const ms = Date.now() - t0;
assert(d != null, "experience回答でも done で終わる（ハングしない）");
assert(d.meta.currentKey === "skills", "Gemini失敗時はフォールバックして次(skills)へ進む");
console.log(`  (deepenターン所要: ${ms}ms / 失敗→フォールバック)`);
console.log("\n🎉 Geminiフォールバック検証 通過");
