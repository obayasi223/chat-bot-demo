// lib/gemini.ts
// Google Gemini の薄いラッパー。web_hearing の呼び出しパターンに合わせている。
import { GoogleGenAI } from "@google/genai";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

let client: GoogleGenAI | null = null;

export function hasGemini(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

function getClient(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

export type GenOptions = {
  signal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
};

function buildConfig(opts?: GenOptions) {
  if (!opts) return undefined;
  const config: Record<string, unknown> = {};
  if (opts.signal) config.abortSignal = opts.signal;
  if (typeof opts.maxOutputTokens === "number")
    config.maxOutputTokens = opts.maxOutputTokens;
  if (typeof opts.temperature === "number") config.temperature = opts.temperature;
  return Object.keys(config).length > 0 ? config : undefined;
}

/** プロンプトを渡してテキスト応答を得る。失敗時は例外を投げる。 */
export async function generateText(
  prompt: string,
  opts?: GenOptions
): Promise<string> {
  const ai = getClient();
  const res = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: buildConfig(opts),
  });
  return String((res as any)?.text ?? "").trim();
}

/**
 * プロンプトを渡し、生成テキストを差分（delta）として逐次 yield する。
 * 最初のトークンが届いた時点で処理を始められるため、体感速度が上がる。
 * 失敗時は例外を投げる。opts.signal で中断できる。
 */
export async function* generateTextStream(
  prompt: string,
  opts?: GenOptions
): AsyncGenerator<string, void, unknown> {
  const ai = getClient();
  const stream = await ai.models.generateContentStream({
    model: MODEL,
    contents: prompt,
    config: buildConfig(opts),
  });
  for await (const chunk of stream) {
    if (opts?.signal?.aborted) break;
    const t = String((chunk as any)?.text ?? "");
    if (t) yield t;
  }
}
