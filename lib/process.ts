"use client";

// 1ペア分の処理パイプライン (すべてブラウザ内。要約テキストと点検報告書の切り抜き画像のみ /api へ送る)
import { formatLastUpdatedJst, formatRemarksJst } from "@/lib/jst-date";
import { buildMergedPdfName } from "@/lib/naming";
import { extractTokens } from "@/lib/pdf/extract";
import { mergeReports } from "@/lib/pdf/merge";
import { parsePhotoReport } from "@/lib/pdf/parse-photo-report";
import { renderInspectionPages } from "@/lib/pdf/render";
import type {
  SummarizeRequest,
  SummarizeResponse,
} from "@/lib/summarize/types";
import { toDateNoPad, toHalfWidthAlnum } from "@/lib/text";
import { COLUMNS } from "@/lib/tsv";
import type { Confidence, WorkCategoryEntry } from "@/lib/types";
import type { WorkCategoriesResponse } from "@/lib/work-categories";

export interface UploadedFile {
  id: string;
  name: string;
  file: File;
}

/** 結果テーブルの1報告書分 */
export interface ResultRow {
  pairId: string;
  ownerDisplay: string;
  /** 24列 (工事区分列は空欄のテンプレート。出力時に categories の数だけ行を展開する) */
  cells: string[];
  confidences: Confidence[];
  /** 工事区分 (点検報告書で「有」に丸が付いた項目)。0件なら工事区分空欄の1行を出力 */
  categories: WorkCategoryEntry[];
  categoryEngine: "gemini" | "none";
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
    // サーバー側の予算(30s)より少し長めに取り、通信不能時のハングを防ぐ
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`summarize API ${res.status}`);
  return (await res.json()) as SummarizeResponse;
}

async function requestWorkCategories(images: string[]): Promise<WorkCategoriesResponse> {
  const res = await fetch("/api/work-categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images }),
    // サーバー側の予算(45s)より少し長めに取る
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`work-categories API ${res.status}`);
  return (await res.json()) as WorkCategoriesResponse;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

    const inspectionBytes = inspection
      ? new Uint8Array(await inspection.file.arrayBuffer())
      : null;

    // PDF結合 (写真報告書 → 点検報告書)。要約より先に行い、要約失敗の影響を受けないようにする
    let merged: Blob | null = null;
    if (inspectionBytes) {
      const mergeResult = await mergeReports(photoBytes, inspectionBytes);
      warnings.push(...mergeResult.warnings);
      merged = new Blob([mergeResult.bytes as unknown as BlobPart], {
        type: "application/pdf",
      });
    } else {
      warnings.push("点検報告書が未指定のため結合PDFは作成していません");
    }

    // 要約と工事区分は互いに独立なので並列に実行する (待ち時間の大半がAPI応答)。
    // どちらかが失敗しても他の結果 (抽出済み項目・結合PDF) は残す。
    let summary = "";
    let engine: "gemini" | "rule" | null = null;
    let summaryFailed = false;
    let categories: WorkCategoryEntry[] = [];
    let categoryEngine: "gemini" | "none" = "none";

    const summaryTask = async () => {
      if (!data.templateRecognized) return;
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
          `要約の取得に失敗しました (${errorMessage(e)})。アフター受付内容は手動で入力してください`,
        );
      }
    };

    // 工事区分: 点検報告書 (手書きチェックシート) の「有」の丸を画像認識で判定。
    // 個人情報 (署名・電話番号) は切り落とした画像だけを送る
    const categoryTask = async () => {
      if (!inspectionBytes) {
        warnings.push("点検報告書が無いため工事区分を判定できません");
        return;
      }
      try {
        const rendered = await renderInspectionPages(inspectionBytes.slice());
        warnings.push(...rendered.warnings);
        const res = await requestWorkCategories(rendered.images);
        categoryEngine = res.engine;
        categories = res.categories.map((c) => ({
          value: c.category,
          confidence: c.confidence === "low" ? "warn" : "ok",
          item: c.item,
        }));
        if (res.engine === "none") {
          warnings.push(
            res.error
              ? `工事区分の判定に失敗しました (${res.error})。手動で選択してください`
              : "Gemini APIキー未設定のため工事区分は判定していません。手動で選択してください",
          );
        }
      } catch (e) {
        warnings.push(`工事区分の判定に失敗しました (${errorMessage(e)})。手動で選択してください`);
      }
    };

    await Promise.all([summaryTask(), categoryTask()]);

    for (const f of [
      data.pj,
      data.inspectionTiming,
      data.inspectionDate,
      data.developer,
      data.propertyName,
      data.ownerName,
      data.address,
      data.handoverDate,
    ]) {
      warnings.push(...f.warnings);
    }

    const summaryConfidence: Confidence =
      data.templateRecognized && !summaryFailed ? "ok" : "fail";

    // 最終更新日・備考欄は処理実行日 (日本時間) を自動入力
    const now = new Date();
    const blank = { value: "", confidence: "ok" as Confidence };
    const fixed = (value: string) => ({ value, confidence: "ok" as Confidence });
    const fixedWith = (value: string, confidence: Confidence) => ({ value, confidence });

    // 転記先Excelの列構成そのまま (lib/tsv.ts の COLUMNS と同順・同数)
    const entries: { value: string; confidence: Confidence }[] = [
      blank, // 物件数
      data.pj, // PJ
      data.inspectionTiming, // 受付種別
      fixedWith(toDateNoPad(data.inspectionDate.value), data.inspectionDate.confidence), // 受付日 (点検日 yyyy/m/d)
      fixed("木村"), // 受付者
      blank, // 担当
      data.developer, // 事業者
      data.propertyName, // 物件名称
      data.ownerName, // お客様氏名
      data.address, // 住所
      // 引渡日もゼロ埋めなし表記 (内部表現はYYYY/MM/DDで持ち、出力時に変換)
      fixedWith(toDateNoPad(data.handoverDate.value), data.handoverDate.confidence),
      blank, // 監督
      blank, // 営業
      blank, // 初回訪問日
      blank, // 前回対応日
      blank, // 対応予定日
      blank, // 完了日
      blank, // 完了報告書取得日
      blank, // 工事区分 (出力時に categories の数だけ行展開して埋める)
      fixedWith(summary, summaryConfidence), // アフター受付内容
      blank, // 手配業者
      blank, // 処置
      fixed(formatLastUpdatedJst(now)), // 最終更新日
      fixed(formatRemarksJst(now)), // 備考欄
    ];

    return {
      pairId,
      ownerDisplay,
      cells: entries.map((e) => e.value),
      confidences: entries.map((e) => e.confidence),
      categories,
      categoryEngine,
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
      cells: Array(COLUMNS.length).fill(""),
      confidences: Array(COLUMNS.length).fill("fail") as Confidence[],
      categories: [],
      categoryEngine: "none",
      warnings,
      engine: null,
      merged: null,
      mergedName,
      error: errorMessage(e),
    };
  }
}
