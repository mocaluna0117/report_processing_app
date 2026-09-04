import { GoogleGenAI, Type } from "@google/genai";
import { NextResponse } from "next/server";
import { GEMINI_SUMMARY_CHAIN, callWithModelChain } from "@/lib/gemini-model";
import { formatDefectList } from "@/lib/summarize/defects";
import { exampleSection, redactExamples, sanitizeExamples } from "@/lib/summarize/examples";
import { redactPii } from "@/lib/summarize/redact";
import { formatPhenomena } from "@/lib/summarize/format";
import { INQUIRY_TEXT_MAX, buildInquiryPrompt, ruleBasedInquirySummary } from "@/lib/summarize/inquiry";
import { ruleBasedSummary, stripRequests } from "@/lib/summarize/rule-based";
import type {
  InquiryExampleInput,
  SummarizeRequest,
  SummarizeResponse,
} from "@/lib/summarize/types";

export const runtime = "nodejs";
// Vercel等のサーバーレス環境での関数実行上限
export const maxDuration = 60;
/** リトライ込みの総予算。maxDuration より短くして、必ずフォールバックを返せるようにする */
const BUDGET_MS = 30_000;
/** 1試行あたりのタイムアウト (予算内に2試行が収まる長さ) */
const ATTEMPT_TIMEOUT_MS = 12_000;

/** 想定外のボディでも500にせず、安全な形に整形する (サイズ上限つき) */
function sanitizeRequest(raw: unknown): SummarizeRequest {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
    string,
    unknown
  >;
  const str = (v: unknown, max: number) =>
    typeof v === "string" ? v.slice(0, max) : "";
  const strArray = (v: unknown) =>
    Array.isArray(v)
      ? v.slice(0, 20).map((x) => str(x, 2000)).filter(Boolean)
      : [];
  const defects = (Array.isArray(obj.defects) ? obj.defects : [])
    .slice(0, 50)
    .map((d) => {
      const o = (typeof d === "object" && d !== null ? d : {}) as Record<
        string,
        unknown
      >;
      return {
        location: str(o.location, 100),
        part: str(o.part, 100),
        symptom: str(o.symptom, 200),
        followup: str(o.followup, 200),
        remarks: str(o.remarks, 4000),
      };
    });
  return {
    defects,
    standaloneNotes: strArray(obj.standaloneNotes),
    specialNotes: strArray(obj.specialNotes),
    noAbnormality: obj.noAbnormality === true,
    // 制御文字はプロンプトを壊すので落とす
    inquiryText: str(obj.inquiryText, INQUIRY_TEXT_MAX).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""),
    // 学習した書き方 (件数・長さ・制御文字をここで抑える)
    examples: sanitizeExamples(obj.examples),
  };
}

function buildPrompt(req: SummarizeRequest, examples: InquiryExampleInput[] = []): string {
  const lines: string[] = [
    "あなたは住宅アフターメンテナンス受付の記録係です。",
    "以下は住宅の定期点検で確認された不具合項目の一覧です。",
    "管理表の「アフター受付内容」欄に載せるため、**不具合の事象を1件ずつ短くまとめた配列**を作ってください。",
    "",
    "条件:",
    "- phenomena には**不具合の事象(どこの何がどうなっているか)だけ**を入れる。場所・部位・症状を具体的に含める",
    "- **1つの要素に1つの事象**。場所や症状が異なるものは必ず別の要素に分ける (複数の事象を1要素に詰め込まない)",
    "- 同じ場所・同じ部位で症状が並ぶ場合はまとめてよい (例: 「2階リビング壁のクロスに浮き・隙間」)",
    "- 各要素は句点で終わらせず、体言止めまたは簡潔な叙述にする (例: 「1階洋室天井のクロスに凹凸」)",
    "- お客様の要望は入れない (例: 補修をご希望、見積もりをご希望、無償での対応をご希望、取り付けたい)",
    "- 弊社・貴社の対応方針や判定も入れない (例: 弊社継続対応、別日対応、見積もり希望、是正不可、対応可否は要確認)",
    "- 原因の推測は簡潔であれば含めてよい (例: 下地の不陸によるもの)",
    "- 備考に要望しか書かれていない項目は、事象が無いので配列に入れない",
    "- 点検員のメモ(立ち会いや連絡先の申し送りなど、不具合でないもの)は入れない",
    "- 個人名・住所・電話番号は入れない",
    "- 不具合の事象が1件も無ければ空配列を返す",
    "",
    "良い例: [\"1階洋室天井のクロスに凹凸\", \"2階リビング壁のクロスに浮き・隙間\", \"2階階段ササラ仕上げの剥がれ\"]",
    "悪い例: [\"クロスの凹凸について補修をご希望。弊社にて継続対応いたします。\"] (要望と対応方針が含まれており不可)",
    "悪い例: [\"1階洋室天井のクロスに凹凸、2階リビング壁のクロスに浮き、2階階段の剥がれ\"] (複数の事象が1要素に詰め込まれており不可)",
    "",
    ...exampleSection(examples, { input: "不具合項目", output: "点検内容" }),
    "## 不具合項目",
    // 整形は lib/summarize/defects.ts に置き、「この書き方を学習」の入力と同じ文にする
    formatDefectList(req),
  ];
  return lines.join("\n");
}

/** 受付メモ用。事象が無くても依頼内容で埋められるように分けて受け取る */
const INQUIRY_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    phenomena: {
      type: Type.ARRAY,
      description: "不具合の事象。1要素に1事象",
      items: { type: Type.STRING },
    },
    requests: {
      type: Type.ARRAY,
      description: "不具合ではない依頼 (設備の追加希望など)。1要素に1件",
      items: { type: Type.STRING },
    },
  },
  required: ["phenomena", "requests"],
};

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    phenomena: {
      type: Type.ARRAY,
      description: "不具合の事象。1要素に1事象",
      items: { type: Type.STRING },
    },
  },
  required: ["phenomena"],
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
}

async function callGemini(
  apiKey: string,
  prompt: string,
  schema: object = RESPONSE_SCHEMA,
): Promise<Record<string, unknown>> {
  const ai = new GoogleGenAI({ apiKey });
  const { result } = await callWithModelChain(
    GEMINI_SUMMARY_CHAIN,
    { budgetMs: BUDGET_MS, attemptTimeoutMs: ATTEMPT_TIMEOUT_MS },
    async (model, { thinkingConfig, timeoutMs }) => {
      const res = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: schema,
          httpOptions: { timeout: timeoutMs },
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      });
      const text = res.text?.trim();
      if (!text) throw new Error("Geminiが空の応答を返しました");
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!Array.isArray(parsed.phenomena)) throw new Error("Geminiの応答形式が不正です");
      return parsed;
    },
  );
  return result;
}

export async function POST(request: Request): Promise<NextResponse<SummarizeResponse>> {
  let body: SummarizeRequest;
  try {
    body = sanitizeRequest(await request.json());
  } catch {
    return NextResponse.json(
      { summary: "", engine: "rule", error: "invalid request body" },
      { status: 400 },
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;

  // アフターメンテナンス: コールセンターの受付メモから事象だけを取り出す
  const inquiryText = body.inquiryText?.trim() ?? "";
  if (inquiryText) {
    if (!apiKey) {
      return NextResponse.json({ summary: ruleBasedInquirySummary(inquiryText), engine: "rule" });
    }
    try {
      const parsed = await callGemini(
        apiKey,
        // 手本も伏せ字を掛け直してから渡す (保存時に伏せた上での保険)
        buildInquiryPrompt(redactPii(inquiryText), redactExamples(body.examples ?? [])),
        INQUIRY_RESPONSE_SCHEMA,
      );
      const phenomena = stringArray(parsed.phenomena);
      // 不具合が無い問い合わせ (設備の追加希望など) は、依頼内容をそのまま受付内容にする
      const items = phenomena.length > 0 ? phenomena : stringArray(parsed.requests);
      return NextResponse.json({
        summary: formatPhenomena(items, [], { emptyText: "" }),
        engine: "gemini",
        ...(items.length === 0
          ? { error: "受付メモから内容を取り出せませんでした。受付一覧で直接入力してください" }
          : {}),
      });
    } catch (e) {
      return NextResponse.json({
        summary: ruleBasedInquirySummary(inquiryText),
        engine: "rule",
        error: String(e),
      });
    }
  }

  // 不具合ゼロは定型文で十分 (API呼び出し節約)
  if (!apiKey || (body.defects.length === 0 && body.specialNotes.length === 0 && body.standaloneNotes.length === 0)) {
    return NextResponse.json({ summary: ruleBasedSummary(body), engine: "rule" });
  }

  try {
    // 手本も伏せ字を掛け直してから渡す (保存時に伏せた上での保険)
    const prompt = buildPrompt(body, redactExamples(body.examples ?? []));
    const phenomena = stringArray((await callGemini(apiKey, prompt)).phenomena);
    // 番号付け・改行はサーバー側で行い、モデルの表記揺れに左右されないようにする
    const notes = body.standaloneNotes.map((n) => stripRequests(n)).filter(Boolean);
    return NextResponse.json({
      summary: formatPhenomena(phenomena, notes),
      engine: "gemini",
    });
  } catch (e) {
    // Gemini失敗時はルールベースにフォールバック (バッチを止めない)
    return NextResponse.json({
      summary: ruleBasedSummary(body),
      engine: "rule",
      error: String(e),
    });
  }
}
