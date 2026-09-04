"use client";

// 1ペア分の処理パイプライン (すべてブラウザ内。/api へ送るのは 要約テキスト・点検報告書の切り抜き画像・施主名(カナ推定用) のみ)
import { buildCells, blankCells, entry } from "@/lib/cells";
import { formatLastUpdatedJst, formatRemarksJst } from "@/lib/jst-date";
import type { NameReadingResponse } from "@/lib/kana";
import { buildMergedPdfName } from "@/lib/naming";
import { DEFAULT_REPORT_OPTIONS, type ReportKind, type ReportOptions } from "@/lib/report/model";
import { extractTokens } from "@/lib/pdf/extract";
import { mergeReports } from "@/lib/pdf/merge";
import { parseInspectionContacts } from "@/lib/pdf/parse-inspection-report";
import { parsePhotoReport } from "@/lib/pdf/parse-photo-report";
import { renderInspectionPages } from "@/lib/pdf/render";
import type {
  SummarizeRequest,
  SummarizeResponse,
} from "@/lib/summarize/types";
import { formatDefectList } from "@/lib/summarize/defects";
import {
  type InquiryExample,
  selectInquiryExamples,
} from "@/lib/summarize/examples";
import { attachSummaries } from "@/lib/summary";
import { toDateNoPad, toDateZeroPad, toFullWidthSpace, toHalfWidthAlnum } from "@/lib/text";
import { PROPERTY_COUNT_MARK } from "@/lib/tsv";
import type { Confidence, Contact, WorkCategoryEntry } from "@/lib/types";
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
  /** 完了報告書の既定値・別紙タイトルの出し分け (省略時は定期点検) */
  kind?: ReportKind;
  /** 24列 (工事区分列は空欄のテンプレート。出力時に categories の数だけ行を展開する) */
  cells: string[];
  confidences: Confidence[];
  /**
   * 工事区分 (点検報告書で「有」に丸が付いた項目)。0件なら工事区分空欄の1行を出力。
   * 2件以上なら点検内容を区分ごとに分けて各 summary に持ち、
   * cells[SUMMARY_COL] は各行の本文をまとめた鏡にしておく (recordSummary と同じ値)。
   */
  categories: WorkCategoryEntry[];
  /**
   * 物件数の★を扱うようになったあとに作られた行か。
   * 読み込み時の読み替え (lib/row-normalize.ts) が、利用者が消した★を戻さないための印。
   */
  propertyCountMarked?: boolean;
  /**
   * 要約APIへ送った不具合項目の文 (伏せ字済み)。「この書き方を学習」の入力に使う。
   * 古い保存データには無い。
   */
  redactedDefects?: string;
  /** 処理した時点の要約 (手直し前)。学習ボタンで「手直し済みか」を出すのに使う */
  originalSummary?: string;
  categoryEngine: "gemini" | "none";
  /** 工事区分の判定に使えたモデル名 (表示用) */
  categoryModel?: string;
  /** 完了報告書の立会・受付項目のチェック状態 (ダイアログで変更でき、保存される) */
  report: ReportOptions;
  /** メール文の組み立てに使う情報 (ブラウザ内でのみ保持) */
  mail: {
    /** 施主名のカナ読み (Gemini推定。失敗時は空で手入力) */
    ownerKana: string;
    /** ok: 読みが定まる / warn: 候補あり・要確認 / fail: 未取得 */
    kanaConfidence: Confidence;
    kanaAlternatives: string[];
    /** 点検報告書から抽出した連絡先 (① → ② の順) */
    contacts: Contact[];
  };
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

async function requestNameReading(name: string): Promise<NameReadingResponse> {
  const res = await fetch("/api/name-reading", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    // サーバー側の予算(30s)より少し長めに取る
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`name-reading API ${res.status}`);
  return (await res.json()) as NameReadingResponse;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function processPair(
  pairId: string,
  ownerDisplay: string,
  date: string | null,
  photo: UploadedFile,
  inspection: UploadedFile | null,
  /** 「この書き方を学習」で覚えた手本 (今回の不具合項目に近いものだけ送る) */
  examples: readonly InquiryExample[] = [],
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
    let redactedDefects = "";
    let categories: WorkCategoryEntry[] = [];
    let categoryEngine: "gemini" | "none" = "none";
    let categoryModel: string | undefined;
    let contacts: Contact[] = [];
    let ownerKana = "";
    let kanaConfidence: Confidence = "fail";
    let kanaAlternatives: string[] = [];

    const summaryTask = async () => {
      if (!data.templateRecognized) return;
      const request: SummarizeRequest = {
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
      };
      // 学習の入力に使うので、プロンプトに載るのと同じ文 (伏せ字済み) を残す
      redactedDefects = formatDefectList(request);
      try {
        const res = await requestSummary({
          ...request,
          // 今回の不具合項目に近い手本だけを送る
          examples: selectInquiryExamples(redactedDefects, examples).map(({ input, output }) => ({
            input,
            output,
          })),
        });
        summary = toHalfWidthAlnum(res.summary);
        engine = res.engine;
        if (res.error) warnings.push(`要約API: ${res.error}`);
      } catch (e) {
        summaryFailed = true;
        warnings.push(
          `要約の取得に失敗しました (${errorMessage(e)})。点検内容は手動で入力してください`,
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
        // 連絡先はテキスト層から取る (API呼び出しの前に確定させ、判定が失敗しても残す)
        contacts = parseInspectionContacts(rendered.tokens);
        warnings.push(...rendered.warnings);
        const res = await requestWorkCategories(rendered.images);
        categoryEngine = res.engine;
        categoryModel = res.model;
        if (res.skipped?.length) {
          warnings.push(`工事区分: ${res.skipped.join("・")} のため別モデルで判定しました`);
        }
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

    // 施主名のカナ読み (メール文用)。漢字の氏名だけを送り、失敗しても確認画面で手入力できる
    const kanaTask = async () => {
      if (!data.templateRecognized || !data.ownerName.value) return;
      try {
        const res = await requestNameReading(data.ownerName.value);
        ownerKana = res.kana;
        kanaAlternatives = res.alternatives;
        kanaConfidence =
          res.engine === "none" || !res.kana ? "fail" : res.confidence === "high" ? "ok" : "warn";
        if (res.error) {
          warnings.push(
            `カナ読みの推定に失敗しました (${res.error})。メール文の確認画面で手入力してください`,
          );
        }
      } catch (e) {
        warnings.push(
          `カナ読みの推定に失敗しました (${errorMessage(e)})。メール文の確認画面で手入力してください`,
        );
      }
    };

    await Promise.all([summaryTask(), categoryTask(), kanaTask()]);

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

    // 転記先Excelの列構成 (lib/cells.ts が COLUMNS の順に並べる)
    const built = buildCells({
      // 物件数は記録1件の印 (行に展開するときは先頭の行だけに残る)
      物件数: entry(PROPERTY_COUNT_MARK),
      PJ: data.pj,
      受付種別: data.inspectionTiming,
      // 受付日 = 点検日 (ゼロ埋めなし yyyy/m/d)
      受付日: entry(toDateNoPad(data.inspectionDate.value), data.inspectionDate.confidence),
      受付者: entry("木村"),
      事業者: data.developer,
      物件名称: data.propertyName,
      // お客様氏名は姓名の間を全角スペースにする (結合PDF名は半角スペースのまま)
      お客様氏名: entry(toFullWidthSpace(data.ownerName.value), data.ownerName.confidence),
      住所: data.address,
      // 引渡日はゼロ埋め表記 (yyyy/mm/dd)
      引渡日: entry(toDateZeroPad(data.handoverDate.value), data.handoverDate.confidence),
      // 工事区分は出力時に categories の数だけ行展開して埋める
      アフター受付内容: entry(summary, summaryConfidence),
      最終更新日: entry(formatLastUpdatedJst(now)),
      備考欄: entry(formatRemarksJst(now)),
    });

    // 工事区分が2件以上なら点検内容を区分ごとに振り分け、共通のセルはその鏡にする (常に区分ごとに分ける)。
    // 要約が取れなかったときは全行が空欄になり、confidences は fail のまま各行に赤で出る
    const attached = attachSummaries(built.cells, categories);

    return {
      pairId,
      ownerDisplay,
      cells: attached.cells,
      confidences: built.confidences,
      categories: attached.categories,
      propertyCountMarked: true,
      redactedDefects,
      originalSummary: summary,
      categoryEngine,
      categoryModel,
      report: DEFAULT_REPORT_OPTIONS,
      mail: { ownerKana, kanaConfidence, kanaAlternatives, contacts },
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
      propertyCountMarked: true,
      ...blankCells(),
      categories: [],
      categoryEngine: "none",
      report: DEFAULT_REPORT_OPTIONS,
      mail: { ownerKana: "", kanaConfidence: "fail", kanaAlternatives: [], contacts: [] },
      warnings,
      engine: null,
      merged: null,
      mergedName,
      error: errorMessage(e),
    };
  }
}
