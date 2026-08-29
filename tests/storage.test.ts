import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { PairView } from "@/components/pair-table";
import type { ResultRow, UploadedFile } from "@/lib/process";
import { DEFAULT_REPORT_OPTIONS } from "@/lib/report/model";
import {
  clearAll,
  clearResults,
  collectGarbage,
  hasStoredData,
  isQuotaError,
  loadSession,
  saveFiles,
  saveMergedPdf,
  savePairs,
  saveResults,
} from "@/lib/storage";
import { COLUMNS } from "@/lib/tsv";

const pdf = (name: string, size = 16): UploadedFile => ({
  id: `f-${name}`,
  name,
  file: new File([new Uint8Array(size)], name, { type: "application/pdf" }),
});

const row = (pairId: string, merged: Blob | null = null): ResultRow => ({
  pairId,
  ownerDisplay: "山田 太郎",
  cells: COLUMNS.map((c) => `v:${c}`),
  confidences: COLUMNS.map(() => "ok" as const),
  categories: [{ value: "クロス", confidence: "ok" }],
  categoryEngine: "gemini",
  report: DEFAULT_REPORT_OPTIONS,
  mail: { ownerKana: "ヤマダ　タロウ", kanaConfidence: "ok", kanaAlternatives: [], contacts: [] },
  warnings: [],
  engine: "gemini",
  merged,
  mergedName: `${pairId}.pdf`,
  error: null,
});

beforeEach(async () => {
  await clearAll();
});

describe("storage", () => {
  it("何も保存していなければ空のセッション", async () => {
    expect(await loadSession()).toEqual({ files: [], pairs: [], results: [], partialErrors: [] });
  });

  it("ファイルを保存すると File のまま復元できる", async () => {
    const a = pdf("20260101 【写真報告書】山田　太郎様邸.PDF", 100);
    await saveFiles([a]);
    const { files } = await loadSession();
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe(a.id);
    expect(files[0].name).toBe(a.name);
    expect(files[0].file.size).toBe(100);
    expect(new Uint8Array(await files[0].file.arrayBuffer())).toHaveLength(100);
  });

  it("ペアリングは保存後に消えたファイルへの参照を外し、空になったペアは捨てる", async () => {
    const a = pdf("photo.PDF");
    await saveFiles([a]);
    const pairs: PairView[] = [
      { id: "p1", photoId: a.id, inspectionId: "gone", date: "20260101", ownerDisplay: "山田 太郎", needsReview: false, manual: true },
      { id: "p2", photoId: "gone2", inspectionId: null, date: null, ownerDisplay: "", needsReview: false },
    ];
    await savePairs(pairs);
    const { pairs: restored } = await loadSession();
    expect(restored).toEqual([{ ...pairs[0], inspectionId: null }]);
  });

  it("結果は結合PDFと一緒に復元され、順序も保たれる", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" });
    await saveResults([row("p1", blob), row("p2")]);
    await saveMergedPdf("p1", blob);
    const { results } = await loadSession();
    expect(results.map((r) => r.pairId)).toEqual(["p1", "p2"]);
    expect(results[0].merged).toBeInstanceOf(Blob);
    expect(results[0].merged?.size).toBe(3);
    expect(results[1].merged).toBeNull();
    expect(results[0].cells).toEqual(COLUMNS.map((c) => `v:${c}`));
    expect(results[0].mail.ownerKana).toBe("ヤマダ　タロウ");
  });

  it("結果JSONの保存では結合PDFを書かない (セル編集のたびに巨大Blobを書き直さない)", async () => {
    const blob = new Blob([new Uint8Array(1000)]);
    await saveResults([row("p1", blob)]);
    const { results } = await loadSession();
    expect(results[0].merged).toBeNull(); // saveMergedPdf を呼んでいないので無い
  });

  it("列構成が変わった古い結果は読み捨てる", async () => {
    const stale = { ...row("p1"), cells: ["a", "b"] };
    await saveResults([stale as ResultRow, row("p2")]);
    const { results } = await loadSession();
    expect(results.map((r) => r.pairId)).toEqual(["p2"]);
  });

  it("clearResults は結果と結合PDFだけ消し、ファイルとペアは残す", async () => {
    const a = pdf("photo.PDF");
    await saveFiles([a]);
    await savePairs([{ id: "p1", photoId: a.id, inspectionId: null, date: null, ownerDisplay: "", needsReview: false }]);
    await saveResults([row("p1")]);
    await saveMergedPdf("p1", new Blob([new Uint8Array(3)]));
    await clearResults();
    const s = await loadSession();
    expect(s.files).toHaveLength(1);
    expect(s.pairs).toHaveLength(1);
    expect(s.results).toEqual([]);
  });

  it("空配列では既存のペア・結果を上書きしない (復元前の空状態で消さないため)", async () => {
    const pairs: PairView[] = [
      { id: "p1", photoId: null, inspectionId: "i1", date: null, ownerDisplay: "", needsReview: false },
    ];
    await saveFiles([{ ...pdf("insp.PDF"), id: "i1" }]);
    await savePairs(pairs);
    await saveResults([row("p1")]);

    await savePairs([]);
    await saveResults([]);

    const s = await loadSession();
    expect(s.pairs).toHaveLength(1);
    expect(s.results).toHaveLength(1);
  });

  it("clearResults は対象の結合PDFだけ消す (他セッションの分を巻き込まない)", async () => {
    await saveResults([row("p1"), row("p2")]);
    await saveMergedPdf("p1", new Blob([new Uint8Array(3)]));
    await saveMergedPdf("other", new Blob([new Uint8Array(5)]));
    await clearResults(["p1"]);
    await saveResults([row("other")]);
    await saveMergedPdf("other2", new Blob([new Uint8Array(7)]));
    const s = await loadSession();
    // p1 の結合PDFは消え、other の分は残っている
    expect(s.results.find((r) => r.pairId === "other")?.merged?.size).toBe(5);
  });

  it("collectGarbage は結果に紐づかない結合PDFを掃除する", async () => {
    await saveResults([row("p1")]);
    await saveMergedPdf("p1", new Blob([new Uint8Array(3)]));
    await saveMergedPdf("stale", new Blob([new Uint8Array(9)]));
    await collectGarbage(new Set(["p1"]));
    const s = await loadSession();
    expect(s.results[0].merged?.size).toBe(3);
    // 孤児は消えている (次の loadSession で紐づく先が無い)
    await saveResults([row("p1"), row("stale")]);
    const after = await loadSession();
    expect(after.results.find((r) => r.pairId === "stale")?.merged).toBeNull();
  });

  it("hasStoredData は保存データの有無を返す", async () => {
    expect(await hasStoredData()).toBe(false);
    await saveFiles([pdf("photo.PDF")]);
    expect(await hasStoredData()).toBe(true);
    await clearAll();
    expect(await hasStoredData()).toBe(false);
  });

  it("loadSession は一部が読めなくても読めた分を返す", async () => {
    const s = await loadSession();
    expect(s.partialErrors).toEqual([]);
  });

  it("isQuotaError は容量不足を見分ける", () => {
    expect(isQuotaError(new DOMException("full", "QuotaExceededError"))).toBe(true);
    expect(isQuotaError(new Error("Quota exceeded"))).toBe(true);
    expect(isQuotaError(new Error("boom"))).toBe(false);
  });

  it("clearAll ですべて消える", async () => {
    await saveFiles([pdf("photo.PDF")]);
    await saveResults([row("p1")]);
    await clearAll();
    expect(await loadSession()).toEqual({ files: [], pairs: [], results: [], partialErrors: [] });
  });
});

describe("完了報告書のチェック状態", () => {
  it("保存・復元でき、古い保存データ (report なし) は既定値になる", async () => {
    const custom = {
      attendance: { owner: true, family: false, other: false },
      categories: { inspection: false, after: true, paid: false, direct: false, free: false },
    };
    await saveResults([
      { ...row("p-1"), report: custom },
      // 古い形式: report フィールドが無い
      { ...row("p-2"), report: undefined as unknown as ResultRow["report"] },
    ]);
    const { results } = await loadSession();
    expect(results.find((r) => r.pairId === "p-1")?.report).toEqual(custom);
    expect(results.find((r) => r.pairId === "p-2")?.report).toEqual(DEFAULT_REPORT_OPTIONS);
  });
});

describe("保存データの有無の判定", () => {
  it("消去後に空のペアリング・結果が書き戻されても「保存データあり」にはしない", async () => {
    await saveFiles([pdf("a.pdf")]);
    await savePairs([{ id: "p-1", photoId: "f-a.pdf", inspectionId: null } as PairView]);
    expect(await hasStoredData()).toBe(true);

    await clearAll();
    expect(await hasStoredData()).toBe(false);
    // 画面側の保存処理が消去直後に空配列を書き戻しても、判定は変わらない
    await savePairs([]);
    await saveResults([]);
    expect(await hasStoredData()).toBe(false);
  });
});
