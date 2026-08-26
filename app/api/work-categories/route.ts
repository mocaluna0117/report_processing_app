import { GoogleGenAI, Type } from "@google/genai";
import { NextResponse } from "next/server";
import { GEMINI_VISION_CHAIN, callWithModelChain } from "@/lib/gemini-model";
import {
  WORK_CATEGORIES,
  normalizeHits,
  type WorkCategoriesResponse,
  type WorkCategoryHit,
  type FlaggedItem,
} from "@/lib/work-categories";

export const runtime = "nodejs";
// Vercel等のサーバーレス環境での関数実行上限
export const maxDuration = 60;
/** リトライ込みの総予算。maxDuration(60秒) より短くして、必ずフォールバックを返せるようにする */
const BUDGET_MS = 50_000;
/** 1試行あたりのタイムアウト。実測で最大25.8秒かかったため余裕を取り、予算内に2試行が収まる長さ */
const ATTEMPT_TIMEOUT_MS = 24_000;

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
  "表には行が並び、各行の左に「項目」名(基礎・外壁・クロス など)、中央に「不具合」列の「有 ・ 無」の印字があり、点検員が手書きでどちらか一方に丸(円)を付けています。",
  "",
  "あなたの仕事: **その画像の表に実際に印字されている行だけ**を上から順に1行ずつ調べ、「有」の側に丸が付いている行を抜き出し、その行の項目名を工事区分一覧に対応付けて返してください。",
  `工事区分一覧: ${WORK_CATEGORIES.join(" / ")}`,
  "",
  "厳守すべきルール:",
  "1. 画像の表に印字されていない項目は絶対に出力しない。シートの種類によって行構成は異なり(戸建て版は内外装すべて、賃貸・共同住宅版は外部項目のみ など)、存在しない行を推測で足すのは誤りである。",
  "2. 判定の主たる根拠は丸の位置。「無」の側に丸がある行は出力しない。丸が無い行も出力しない。",
  "3. 補強証拠: 「有」の行は通常、右側の「場所・部位・詳細状況・対応内容」列に手書きメモがあり、「対応」列(完了/別日対応/見積)にも丸が付く。右側が完全に空欄の行は「無」の可能性が非常に高い。丸の位置が曖昧なときはこの証拠を重視する。",
  "4. 迷った場合は出力しない方を選ぶ。誤って多く出すより確実なものだけを出す方が良い。ただし「有」に丸があると判断でき、かつ判別に不安が残る行は confidence を \"low\" にして含める。",
  "5. 「外部建具(サッシ)」は サッシ、「外部天井(軒天)」は 軒天、「外部塗装」「内部塗装」は その他 として扱う。",
  "6. 同じ項目名の行が複数(例: 基礎が2行)あり複数に丸があっても1件にまとめる。",
  "7. 表の下部にある「上記以外の報告事項」「御見積り詳細」「その他」欄の手書きメモは項目行ではないので出力に含めない。",
  "8. 「有」に丸がある行が1件も無ければ空配列を返す(空配列は正常な回答である)。",
  "9. 手書きメモの文面や顧客情報(氏名・電話番号・契約番号)は読み取らず、出力に含めない。",
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

async function callGemini(
  apiKey: string,
  images: string[],
): Promise<{ hits: WorkCategoryHit[]; model: string; skipped: string[] }> {
  const ai = new GoogleGenAI({ apiKey });
  const { result, model, skipped } = await callWithModelChain(
    GEMINI_VISION_CHAIN,
    { budgetMs: BUDGET_MS, attemptTimeoutMs: ATTEMPT_TIMEOUT_MS },
    async (model, { thinkingConfig, timeoutMs }) => {
      const res = await ai.models.generateContent({
        model,
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
          httpOptions: { timeout: timeoutMs },
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      });
      const text = res.text?.trim();
      if (!text) throw new Error("Geminiが空の応答を返しました");
      const parsed = JSON.parse(text) as { flagged?: unknown };
      return normalizeHits(Array.isArray(parsed.flagged) ? (parsed.flagged as FlaggedItem[]) : []);
    },
  );
  return { hits: result, model, skipped };
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
    const { hits, model, skipped } = await callGemini(apiKey, images);
    return NextResponse.json({
      categories: hits,
      engine: "gemini",
      model,
      // 上限到達などで飛ばしたモデルがあれば、残り枠の目安として伝える
      ...(skipped.length > 0 ? { skipped } : {}),
    });
  } catch (e) {
    return NextResponse.json({ categories: [], engine: "none", error: String(e) });
  }
}
