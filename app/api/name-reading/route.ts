import { GoogleGenAI, Type } from "@google/genai";
import { NextResponse } from "next/server";
import { GEMINI_KANA_CHAIN, callWithModelChain } from "@/lib/gemini-model";
import { normalizeNameReading, type NameReadingResponse } from "@/lib/kana";

export const runtime = "nodejs";
// Vercel等のサーバーレス環境での関数実行上限
export const maxDuration = 60;
/** リトライ込みの総予算。maxDuration より短くして、必ず応答を返せるようにする */
const BUDGET_MS = 30_000;
/** 1試行あたりのタイムアウト */
const ATTEMPT_TIMEOUT_MS = 12_000;

const NONE: NameReadingResponse = {
  kana: "",
  alternatives: [],
  confidence: "low",
  engine: "none",
};

/** 想定外のボディでも500にせず、氏名だけを取り出す (住所等は受け付けない) */
function sanitizeName(raw: unknown): string {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof obj.name !== "string") return "";
  return obj.name
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 50);
}

function buildPrompt(name: string): string {
  return [
    "次の氏名 (日本語の漢字表記。姓と名は空白で区切られています) のカタカナ読みを答えてください。",
    `氏名: ${name}`,
    "",
    "条件:",
    "- kana には最も一般的な読みをカタカナで、姓と名の間を全角スペースで区切って入れる (例: ヤマダ　タロウ)",
    "- 読みが複数考えられる名前 (例: 裕子=ユウコ/ヒロコ、清=キヨシ/セイ) は最も一般的なものを kana に、他を alternatives に入れ、confidence を low にする",
    "- 中国・韓国など外国人名は日本で一般的な音読み (例: 張=チョウ) を kana にし、confidence を low にする",
    "- 読みが一つに定まる一般的な名前だけ confidence を high にする",
    "- 読み以外の説明は出力しない",
  ].join("\n");
}

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    kana: { type: Type.STRING, description: "カタカナの読み。姓と名の間は全角スペース" },
    alternatives: { type: Type.ARRAY, items: { type: Type.STRING } },
    confidence: { type: Type.STRING, enum: ["high", "low"] },
  },
  required: ["kana", "alternatives", "confidence"],
};

async function callGemini(apiKey: string, name: string) {
  const ai = new GoogleGenAI({ apiKey });
  const { result } = await callWithModelChain(
    GEMINI_KANA_CHAIN,
    { budgetMs: BUDGET_MS, attemptTimeoutMs: ATTEMPT_TIMEOUT_MS },
    async (model, { thinkingConfig, timeoutMs }) => {
      const res = await ai.models.generateContent({
        model,
        contents: buildPrompt(name),
        config: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
          httpOptions: { timeout: timeoutMs },
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      });
      const text = res.text?.trim();
      if (!text) throw new Error("Geminiが空の応答を返しました");
      return normalizeNameReading(JSON.parse(text) as Record<string, unknown>);
    },
  );
  return result;
}

export async function POST(request: Request): Promise<NextResponse<NameReadingResponse>> {
  let name: string;
  try {
    name = sanitizeName(await request.json());
  } catch {
    return NextResponse.json({ ...NONE, error: "invalid request body" }, { status: 400 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !name) return NextResponse.json(NONE);

  try {
    const reading = await callGemini(apiKey, name);
    return NextResponse.json({ ...reading, engine: "gemini" });
  } catch (e) {
    return NextResponse.json({ ...NONE, error: String(e) });
  }
}
