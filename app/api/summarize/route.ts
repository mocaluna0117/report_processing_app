import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { GEMINI_MODEL } from "@/lib/gemini-model";
import { redactPii } from "@/lib/summarize/redact";
import { ruleBasedSummary } from "@/lib/summarize/rule-based";
import type { SummarizeRequest, SummarizeResponse } from "@/lib/summarize/types";

export const runtime = "nodejs";
// Vercel等のサーバーレス環境での関数実行上限 (Geminiのリトライ込みで収まる長さ)
export const maxDuration = 60;

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
  };
}

function buildPrompt(req: SummarizeRequest): string {
  const lines: string[] = [
    "あなたは住宅アフターメンテナンス受付の記録係です。",
    "以下は住宅の定期点検で確認された不具合項目の一覧です。",
    "管理表の「アフター受付内容」欄に入れる日本語の要約を1〜2文で作成してください。",
    "",
    "条件:",
    "- どこの何がどうなっていて、お客様が何を希望しているか(補修希望・見積もり希望など)と対応方針が分かること",
    "- 個人名・住所・電話番号は含めない",
    "- 前置きや説明は不要。要約文のみを出力する",
    "",
    "## 不具合項目",
  ];
  if (req.defects.length === 0) {
    lines.push("(不具合の指摘なし)");
  }
  req.defects.forEach((d, i) => {
    lines.push(
      `${i + 1}. 場所: ${d.location || "-"} / 部位: ${d.part || "-"} / 症状: ${d.symptom || "-"} / 事後対応: ${d.followup || "-"}`,
    );
    if (d.remarks) lines.push(`   備考: ${redactPii(d.remarks)}`);
  });
  if (req.specialNotes.length > 0) {
    lines.push("## 特記事項");
    for (const n of req.specialNotes) lines.push(`- ${redactPii(n)}`);
  }
  if (req.standaloneNotes.length > 0) {
    lines.push("## 点検員メモ");
    for (const n of req.standaloneNotes) lines.push(`- ${redactPii(n)}`);
  }
  return lines.join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  // 無応答時に逐次バッチ全体がハングしないようタイムアウトを設定
  const ai = new GoogleGenAI({ apiKey, httpOptions: { timeout: 30_000 } });
  const delays = [0, 2000, 8000]; // 無料枠のレート制限(429)向け指数バックオフ
  let lastError: unknown;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      const res = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt,
        config: { temperature: 0.2 },
      });
      const text = res.text?.trim();
      if (text) return text;
      lastError = new Error("Geminiが空の応答を返しました");
    } catch (e) {
      lastError = e;
      const msg = String(e);
      // 4xx (429以外) はリトライしても無駄なので打ち切る
      if (/\b4\d{2}\b/.test(msg) && !/429/.test(msg)) throw e;
    }
  }
  throw lastError;
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

  // 不具合ゼロは定型文で十分 (API呼び出し節約)
  if (!apiKey || (body.defects.length === 0 && body.specialNotes.length === 0 && body.standaloneNotes.length === 0)) {
    return NextResponse.json({ summary: ruleBasedSummary(body), engine: "rule" });
  }

  try {
    const summary = await callGemini(apiKey, buildPrompt(body));
    return NextResponse.json({ summary, engine: "gemini" });
  } catch (e) {
    // Gemini失敗時はルールベースにフォールバック (バッチを止めない)
    return NextResponse.json({
      summary: ruleBasedSummary(body),
      engine: "rule",
      error: String(e),
    });
  }
}
