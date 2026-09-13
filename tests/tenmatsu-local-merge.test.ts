import { describe, expect, it } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
import { imageKindOf, imageToPdfBytes, jpegOrientation, orientationMatrix } from "@/lib/tenmatsu/local/image";
import { OFFICE_NOT_CONVERTED, mergeParts } from "@/lib/tenmatsu/local/merge";
import { makeEncryptedPdf, makeJpeg, makePdf, makePng, pageSizes } from "./helpers/pdf-parts";

// 期待値は移植元 tenmatsu.py の merge_to_pdf / image_to_pdf_bytes の検証（smoke_test.py「結合」）の規則から写した

describe("画像を1ページの PDF にする", () => {
  it("形式は中身で見分ける", () => {
    expect(imageKindOf(makeJpeg(10, 10))).toBe("jpeg");
    expect(imageKindOf(makePng(2, 2))).toBe("png");
    expect(imageKindOf(new TextEncoder().encode("%PDF-1.4"))).toBeNull();
  });

  it("縦長の画像は A4 縦", async () => {
    expect(await pageSizes(await imageToPdfBytes(makeJpeg(300, 400), "縦.jpg"))).toEqual([[595, 842]]);
  });

  it("★横長の画像は用紙も横向き（図面・写真が小さくなりすぎないように）", async () => {
    expect(await pageSizes(await imageToPdfBytes(makeJpeg(400, 300), "横.jpg"))).toEqual([[842, 595]]);
    expect(await pageSizes(await imageToPdfBytes(makePng(40, 30), "横.png"))).toEqual([[842, 595]]);
  });

  it("★EXIF の向きを読む（スマホ写真）", () => {
    expect(jpegOrientation(makeJpeg(10, 10, 6))).toBe(6);
    expect(jpegOrientation(makeJpeg(10, 10))).toBe(1);
    expect(jpegOrientation(makeJpeg(10, 10, 9))).toBe(1); // 範囲外は回さない
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(1);
  });

  it("★横長で保存されていても、向きが「90度回す」なら縦長として紙を選ぶ", async () => {
    expect(await pageSizes(await imageToPdfBytes(makeJpeg(400, 300, 6), "回転.jpg"))).toEqual([[595, 842]]);
    expect(await pageSizes(await imageToPdfBytes(makeJpeg(400, 300, 3), "逆さ.jpg"))).toEqual([[842, 595]]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("向き %i: 保存された画像の角が、見た目の正しい角に来る", (orientation) => {
    const box = { x: 10, y: 20, w: 300, h: 200 };
    const [a, b, c, d, e, f] = orientationMatrix(orientation, box);
    const at = (u: number, v: number) => [a * u + c * v + e, b * u + d * v + f];
    const left = box.x;
    const right = box.x + box.w;
    const bottom = box.y;
    const top = box.y + box.h;
    // 保存された画像の左上 (u=0, v=1) が、見た目のどこに来るか（EXIF の定義どおり）
    const topLeft: Record<number, number[]> = {
      1: [left, top],
      2: [right, top],
      3: [right, bottom],
      4: [left, bottom],
      5: [left, top],
      6: [right, top],
      7: [right, bottom],
      8: [left, bottom],
    };
    expect(at(0, 1)).toEqual(topLeft[orientation]);
    // 4つの角がすべて表示枠の角に収まる（はみ出さない・潰れない）
    const corners = [at(0, 0), at(1, 0), at(0, 1), at(1, 1)].map(([x, y]) => `${x},${y}`).sort();
    expect(corners).toEqual([`${left},${bottom}`, `${left},${top}`, `${right},${bottom}`, `${right},${top}`].sort());
  });

  it("画像として読めなければ理由つきで失敗", async () => {
    await expect(imageToPdfBytes(new Uint8Array([1, 2, 3]), "壊れた.jpg")).rejects.toThrow("画像として読めませんでした: 壊れた.jpg");
  });
});

describe("部品を1つの PDF にまとめる", () => {
  it("★並び順どおりに結合し、部品ごとのページ数を同じ順・同じ長さで返す（動画は飛ばして 0）", async () => {
    const outcome = await mergeParts(
      [
        { name: "000_本体.pdf", bytes: await makePdf(2, [595, 842]) },
        { name: "001_現場動画.mp4", bytes: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]) },
        { name: "002_写真.png", bytes: makePng(40, 30) },
        { name: "003_見積.pdf", bytes: await makePdf(1, [400, 400]) },
      ],
      { collectFailures: true },
    );
    expect(outcome.pageCounts).toEqual([2, 0, 1, 1]);
    expect(outcome.totalPages).toBe(4);
    expect(outcome.skipped).toEqual(["001_現場動画.mp4"]);
    expect(await pageSizes(outcome.bytes)).toEqual([
      [595, 842],
      [595, 842],
      [842, 595],
      [400, 400],
    ]);
  });

  it("★Excel などは変換しない。「手で PDF にして入れて」として集め、ページ数は 0", async () => {
    const outcome = await mergeParts(
      [
        { name: "000_本体.pdf", bytes: await makePdf(1) },
        { name: "001_見積.xlsx", bytes: new Uint8Array([0x50, 0x4b, 3, 4]) },
      ],
      { collectFailures: true },
    );
    expect(outcome.failed).toEqual([{ name: "001_見積.xlsx", reason: `${OFFICE_NOT_CONVERTED}（001_見積.xlsx）` }]);
    expect(outcome.pageCounts).toEqual([1, 0]);
  });

  it("★集める指定が無ければ、最初の失敗で止める", async () => {
    await expect(
      mergeParts([
        { name: "000_本体.pdf", bytes: await makePdf(1) },
        { name: "001_謎.zip", bytes: new Uint8Array([1]) },
      ]),
    ).rejects.toThrow("未対応の添付形式です: 001_謎.zip");
  });

  it("★本体（先頭）が読めないときは、集める指定があっても止める", async () => {
    await expect(
      mergeParts([{ name: "000_本体.pdf", bytes: new TextEncoder().encode("<!doctype html><html>ログイン</html>") }], {
        collectFailures: true,
      }),
    ).rejects.toThrow("中身がPDFではなくHTMLです");
  });

  it("★先頭が本体でない並び（捺印決裁書）は strictFirst を外すと先頭の失敗も集める", async () => {
    const outcome = await mergeParts(
      [
        { name: "000_01_入れた書類.xlsx", bytes: new Uint8Array([1]) },
        { name: "001_本体.pdf", bytes: await makePdf(1) },
      ],
      { collectFailures: true, strictFirst: false },
    );
    expect(outcome.failed.map((f) => f.name)).toEqual(["000_01_入れた書類.xlsx"]);
    expect(outcome.totalPages).toBe(1);
  });

  it("★パスワード付きの PDF は無理に結合しない（白紙や文字化けを作らない）", async () => {
    const outcome = await mergeParts(
      [
        { name: "000_本体.pdf", bytes: await makePdf(1) },
        { name: "001_保護.pdf", bytes: makeEncryptedPdf() },
      ],
      { collectFailures: true },
    );
    expect(outcome.failed[0].reason).toContain("パスワード付き");
    expect(outcome.pageCounts).toEqual([1, 0]);
  });

  it("★空の PDF は作らない", async () => {
    await expect(mergeParts([{ name: "動画.mp4", bytes: new Uint8Array([1]) }])).rejects.toThrow("結合できるファイルがありませんでした（飛ばした添付: 動画.mp4）");
    await expect(mergeParts([])).rejects.toThrow("結合対象が空です");
  });

  it("元の PDF の回転を保つ", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 500]).setRotation(degrees(90));
    const outcome = await mergeParts([{ name: "a.pdf", bytes: await doc.save() }]);
    const merged = await PDFDocument.load(outcome.bytes);
    expect(merged.getPage(0).getRotation().angle).toBe(90);
  });
});
