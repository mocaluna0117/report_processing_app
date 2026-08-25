import { GoogleGenAI, Type } from "@google/genai";
import { NextResponse } from "next/server";
import { GEMINI_MODEL } from "@/lib/gemini-model";
import {
  WORK_CATEGORIES,
  normalizeHits,
  type WorkCategoriesResponse,
  type WorkCategoryHit,
  type FlaggedItem,
} from "@/lib/work-categories";

export const runtime = "nodejs";

const MAX_IMAGES = 3;
const MAX_IMAGE_CHARS = 6_000_000; // base64 で約4.5MB

/** 想定外のボディでも500にせず、安全な形に整形する */
function sanitizeImages(raw: unknown): string[] {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(obj.images)) return [];
  return obj.images
    .filter((v): v is string => typeof v === "string")
    .filter((v) => v.length > 0 && v.length <= MAX_IMAGE_CHARS && /^[A-Za-z0-9+/=\s]+$/.test(v))
    .slice(0, MAX_IMAGES);
}

const PROMPT = [
  "画像は住宅の定期点検で使う「点検チェックシート」を撮影したものです。",
  "表の各行には「項目」(基礎・外壁・クロス など) があり、「不具合」列の「有・無」のどちらか一方に点検員が手書きで丸を付けています。",
  "",
  "あなたの仕事: 「有」に丸が付いている行だけを抜き出し、その行の「項目」名を次の工事区分一覧のいずれかに対応付けて返してください。",
  `工事区分一覧: ${WORK_CATEGORIES.join(" / ")}`,
  "",
  "ルール:",
  "- 「無」に丸が付いている行、どちらにも丸が無い行は含めない",
  '- 「有」と「無」の両方に丸がある、丸がどちらに掛かっているか曖昧、かすれて判読しづらい場合は含めた上で confidence を "low" にする',
  '- 項目名が一覧に無い場合 (例: 外部塗装、内部塗装) は最も近いものを選び、無理なら "その他" にして confidence を "low" にする',
  "- 「外部建具(サッシ)」は サッシ、「外部天井(軒天)」は 軒天 として扱う",
  "- 同じ項目 (例: 基礎が2行) に複数の丸があっても1件にまとめる",
  "- 手書きメモ欄の内容や顧客情報は読み取らず、出力に含めない",
  "- 該当が1件も無ければ空配列を返す",
].join("\n");

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    flagged: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          item: { type: Type.STRING, description: "シート上の項目名 (読み取った文字列)" },
          category: { type: Type.STRING, enum: [...WORK_CATEGORIES] },
          confidence: { type: Type.STRING, enum: ["high", "low"] },
        },
        required: ["item", "category", "confidence"],
      },
    },
  },
  required: ["flagged"],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callGemini(apiKey: string, images: string[]): Promise<WorkCategoryHit[]> {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 60_000 } });
  const delays = [0, 2000, 8000]; // 無料枠のレート制限(429)向け指数バックオフ
  let lastError: unknown;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      const res = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: "user",
            parts: [
              ...images.map((data) => ({ inlineData: { mimeType: "image/jpeg", data } })),
              { text: PROMPT },
            ],
          },
        ],
        config: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      });
      const text = res.text?.trim();
      if (!text) {
        lastError = new Error("Geminiが空の応答を返しました");
        continue;
      }
      const parsed = JSON.parse(text) as { flagged?: unknown };
      return normalizeHits(Array.isArray(parsed.flagged) ? (parsed.flagged as FlaggedItem[]) : []);
    } catch (e) {
      lastError = e;
      const msg = String(e);
      if (/\b4\d{2}\b/.test(msg) && !/429/.test(msg)) throw e;
    }
  }
  throw lastError;
}

export async function POST(request: Request): Promise<NextResponse<WorkCategoriesResponse>> {
  let images: string[];
  try {
    images = sanitizeImages(await request.json());
  } catch {
    return NextResponse.json(
      { categories: [], engine: "none", error: "invalid request body" },
      { status: 400 },
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || images.length === 0) {
    return NextResponse.json({ categories: [], engine: "none" });
  }

  try {
    const categories = await callGemini(apiKey, images);
    return NextResponse.json({ categories, engine: "gemini" });
  } catch (e) {
    return NextResponse.json({ categories: [], engine: "none", error: String(e) });
  }
}
