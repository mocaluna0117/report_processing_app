"use client";

// 1ペア分の処理パイプライン (すべてブラウザ内。要約のテキストのみ /api/summarize へ送る)
import { buildMergedPdfName } from "@/lib/naming";
import { toHalfWidthAlnum } from "@/lib/text";
import { extractTokens } from "@/lib/pdf/extract";
import { mergeReports } from "@/lib/pdf/merge";
import { parsePhotoReport } from "@/lib/pdf/parse-photo-report";
import type {
  SummarizeRequest,
  SummarizeResponse,
} from "@/lib/summarize/types";
import type { Confidence } from "@/lib/types";

export interface UploadedFile {
  id: string;
  name: string;
  file: File;
}

/** 結果テーブルの1行 (8列 = PJ, 受付種別, 事業者, 物件名称, お客様氏名, 住所, 引渡日, アフター受付内容) */
export interface ResultRow {
  pairId: string;
  ownerDisplay: string;
  cells: string[];
  confidences: Confidence[];
  warnings: string[];
  engine: "gemini" | "rule" | null;
  merged: Blob | null;
  mergedName: string;
  error: string | null;
}

async function requestSummary(req: SummarizeRequest): Promise<SummarizeResponse> {
  const res = await fetch("/api/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    // サーバー側のリトライ(最大~40s)より長めに取り、通信不能時のハングを防ぐ
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`summarize API ${res.status}`);
  return (await res.json()) as SummarizeResponse;
}

export async function processPair(
  pairId: string,
  ownerDisplay: string,
  date: string | null,
  photo: UploadedFile,
  inspection: UploadedFile | null,
): Promise<ResultRow> {
  const warnings: string[] = [];
  // 抽出前のフォールバック名 (抽出成功後に「〇〇目点検報告書_施主名様／物件名.pdf」へ更新)
  let mergedName = buildMergedPdfName({ fallbackOwner: ownerDisplay });

  try {
    // Fileから1回だけ読む。pdfjsはバッファをworkerへtransferしてdetachするため
    // コピー (.slice()) を渡し、原本は pdf-lib の結合用に温存する。
    const photoBytes = new Uint8Array(await photo.file.arrayBuffer());
    const { tokens, pageCount } = await extractTokens(photoBytes.slice());
    const data = parsePhotoReport(tokens, pageCount, {
      fileNameDate: date ?? undefined,
    });

    // 結合PDF名: 「〇〇目点検報告書_施主名様／物件名.pdf」 (施主名は姓と名の間に半角スペース)
    mergedName = buildMergedPdfName({
      timing: data.inspectionTiming.value,
      ownerName: data.ownerName.value,
      propertyName: data.propertyName.value,
      fallbackOwner: ownerDisplay,
    });

    // PDF結合 (写真報告書 → 点検報告書)。要約より先に行い、要約失敗の影響を受けないようにする
    let merged: Blob | null = null;
    if (inspection) {
      const inspectionBytes = new Uint8Array(await inspection.file.arrayBuffer());
      const mergeResult = await mergeReports(photoBytes, inspectionBytes);
      warnings.push(...mergeResult.warnings);
      merged = new Blob([mergeResult.bytes as unknown as BlobPart], {
        type: "application/pdf",
      });
    } else {
      warnings.push("点検報告書が未指定のため結合PDFは作成していません");
    }

    // 要約 (キー未設定・Gemini失敗時はサーバー側でルールベースにフォールバック)。
    // 通信自体の失敗で抽出済み項目や結合PDFまで失わないよう、ここだけ個別にcatchする
    let summary = "";
    let engine: "gemini" | "rule" | null = null;
    let summaryFailed = false;
    if (data.templateRecognized) {
      try {
        const res = await requestSummary({
          defects: data.defects.map((d) => ({
            location: d.location,
            part: d.part,
            symptom: d.symptom,
            followup: d.followup,
            remarks: d.remarks,
          })),
          standaloneNotes: data.standaloneNotes,
          specialNotes: data.specialNotes,
          noAbnormality: data.noAbnormalityOnPage1 && data.defects.length === 0,
        });
        summary = toHalfWidthAlnum(res.summary);
        engine = res.engine;
        if (res.error) warnings.push(`要約API: ${res.error}`);
      } catch (e) {
        summaryFailed = true;
        warnings.push(
          `要約の取得に失敗しました (${e instanceof Error ? e.message : String(e)})。アフター受付内容は手動で入力してください`,
        );
      }
    }

    const fields = [
      data.pj,
      data.inspectionTiming,
      data.developer,
      data.propertyName,
      data.ownerName,
      data.address,
      data.handoverDate,
    ];
    for (const f of fields) warnings.push(...f.warnings);
    warnings.push(...data.inspectionDate.warnings);

    const summaryConfidence: Confidence =
      data.templateRecognized && !summaryFailed ? "ok" : "fail";

    return {
      pairId,
      ownerDisplay,
      cells: [...fields.map((f) => f.value), summary],
      confidences: [...fields.map((f) => f.confidence), summaryConfidence],
      warnings,
      engine,
      merged,
      mergedName,
      error: null,
    };
  } catch (e) {
    return {
      pairId,
      ownerDisplay,
      cells: Array(8).fill(""),
      confidences: Array(8).fill("fail") as Confidence[],
      warnings,
      engine: null,
      merged: null,
      mergedName,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
