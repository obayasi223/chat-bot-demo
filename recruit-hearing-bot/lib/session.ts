// lib/session.ts
// 認証なしMVP用の簡易セッション。httpOnly Cookie に乱数IDを保持するだけ。
// （web_hearing の招待/再開コードの代わり。ブラウザ単位で会話を識別する）
import { cookies } from "next/headers";
import crypto from "crypto";

const COOKIE = "rhb_sid";
const MAX_AGE = 60 * 60 * 24 * 30; // 30日

/** Cookie からセッションIDを取得。無ければ発行してセットする（Route Handler専用）。 */
export async function getOrCreateSessionId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  if (existing) return existing;

  const sid = crypto.randomUUID();
  jar.set(COOKIE, sid, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
  return sid;
}
