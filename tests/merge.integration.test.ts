// 実際の見本ペアを結合して「写真報告書→点検報告書」の順・全ページ数を検証する。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { parseFileName } from "@/lib/pairing";
import { mergeReports } from "@/lib/pdf/merge";

const photoDir = process.env.SAMPLE_PDF_DIR ?? join(process.cwd(), "写真報告書_例");
const inspectionDir =
  process.env.SAMPLE_INSPECTION_DIR ?? join(process.cwd(), "点検報告書_例");
const available = existsSync(photoDir) && existsSync(inspectionDir);

describe.skipIf(!available)("PDF結合 (実見本)", () => {
  it("写真報告書の全ページ + 点検報告書の全ページが順に結合される", async () => {
    const photo = readdirSync(photoDir).find((f) => /\.pdf$/i.test(f))!;
    const owner = parseFileName(photo).ownerKey;
    const inspection = readdirSync(inspectionDir).find(
      (f) => parseFileName(f).ownerKey === owner,
    )!;
    const photoBytes = new Uint8Array(readFileSync(join(photoDir, photo)));
    const inspectionBytes = new Uint8Array(
      readFileSync(join(inspectionDir, inspection)),
    );
    const photoPages = (await PDFDocument.load(photoBytes)).getPageCount();
    const inspectionPages = (
      await PDFDocument.load(inspectionBytes)
    ).getPageCount();

    const merged = await mergeReports(photoBytes, inspectionBytes);
    expect(merged.warnings).toEqual([]);
    const doc = await PDFDocument.load(merged.bytes);
    expect(doc.getPageCount()).toBe(photoPages + inspectionPages);

    // 先頭ページは写真報告書 (A4縦)
    const first = doc.getPage(0).getSize();
    expect(Math.round(first.height)).toBeGreaterThan(Math.round(first.width));
  });

  it("全5ペアが例外なく結合できる", async () => {
    const photos = readdirSync(photoDir).filter((f) => /\.pdf$/i.test(f));
    for (const photo of photos) {
      const owner = photo.match(/】(.+?)様邸/)?.[1]?.trim();
      const inspection = readdirSync(inspectionDir).find(
        (f) => owner && f.includes(owner),
      );
      expect(inspection, `${photo} の相手が見つからない`).toBeDefined();
      const merged = await mergeReports(
        new Uint8Array(readFileSync(join(photoDir, photo))),
        new Uint8Array(readFileSync(join(inspectionDir, inspection!))),
      );
      const doc = await PDFDocument.load(merged.bytes);
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(3);
    }
  }, 120_000);
});
