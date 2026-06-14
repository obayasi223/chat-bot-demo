// Playwrightで主要画面のスクリーンショットを撮る（UI確認用）。
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const OUT = "/tmp/shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function shot(name, path, viewport, actions) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  if (actions) await actions(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log("saved", `${OUT}/${name}.png`);
  await ctx.close();
}

// ランディング
await shot("landing", "/", { width: 1440, height: 900 });

// ヒアリング（デスクトップ）
await shot("hearing-desktop", "/hearing", { width: 1440, height: 900 });

// ヒアリング（会話を1往復してから）
await shot(
  "hearing-chat",
  "/hearing",
  { width: 1440, height: 900 },
  async (page) => {
    const ta = page.locator("textarea");
    await ta.waitFor({ state: "visible" });
    await ta.fill("大学で情報系を学んでいて、規模の大きな仕事に惹かれました。");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3500);
  }
);

// ヒアリング（モバイル）
await shot("hearing-mobile", "/hearing", { width: 390, height: 844 });

await browser.close();
console.log("done");
