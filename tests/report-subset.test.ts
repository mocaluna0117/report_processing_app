import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { codePointsOf, subsetFont } from "@/lib/report/subset";
import { pickFace, type FaceCandidate } from "@/lib/report/fonts";

const FONT_DIR = join(process.cwd(), "public", "report", "fonts");
const regularFile = existsSync(FONT_DIR)
  ? readdirSync(FONT_DIR).find((f) => f.startsWith("NotoSansJP-Regular"))
  : undefined;
const noto = regularFile
  ? gunzipSync(new Uint8Array(readFileSync(join(FONT_DIR, regularFile))))
  : null;

describe("codePointsOf", () => {
  it("文字列からコードポイントを集め、代替文字も含める", () => {
    const set = codePointsOf(["あA"]);
    expect(set.has("あ".codePointAt(0)!)).toBe(true);
    expect(set.has("A".codePointAt(0)!)).toBe(true);
    // 置き換え用の〓は常に入れる
    expect(set.has("〓".codePointAt(0)!)).toBe(true);
  });
});

describe.skipIf(!noto)("subsetFont", () => {
  it("使う文字だけに絞ると大幅に小さくなり、字形は残る", async () => {
    const text = "完了報告書　施主名 山田　太郎 ①2025/8/25";
    const subset = await subsetFont(noto!, codePointsOf([text]));
    expect(subset.length).toBeLessThan(noto!.length / 10);
    // 絞ったフォントで全ての文字が引ける
    const fontkit = await import("@pdf-lib/fontkit").then((m) => m.default ?? m);
    const font = (fontkit as { create(b: Uint8Array): { characterSet: number[] } }).create(subset);
    const charset = new Set(font.characterSet);
    for (const ch of text.replace(/\s/g, "")) {
      expect(charset.has(ch.codePointAt(0)!), ch).toBe(true);
    }
  }, 30_000);

  it("元のフォントに無い文字は落ちる (呼び出し側で〓に置き換える)", async () => {
    const subset = await subsetFont(noto!, codePointsOf(["\u{2A6B2}あ"]));
    const fontkit = await import("@pdf-lib/fontkit").then((m) => m.default ?? m);
    const font = (fontkit as { create(b: Uint8Array): { characterSet: number[] } }).create(subset);
    const charset = new Set(font.characterSet);
    expect(charset.has("あ".codePointAt(0)!)).toBe(true);
    expect(charset.has(0x2a6b2)).toBe(false);
  }, 30_000);
});

describe("pickFace", () => {
  const faces: FaceCandidate[] = [
    { index: 0, postscriptName: "YuGothic-Regular", fullName: "Yu Gothic Regular", family: "Yu Gothic", weight: 400, isUiVariant: false },
    { index: 1, postscriptName: "YuGothicUI-Semilight", fullName: "Yu Gothic UI Semilight", family: "Yu Gothic UI", weight: 350, isUiVariant: true },
    { index: 2, postscriptName: "YuGothic-Bold", fullName: "Yu Gothic Bold", family: "Yu Gothic", weight: 700, isUiVariant: false },
  ];

  it("太さが近い書体を選び、UI派生は避ける", () => {
    expect(pickFace(faces, "regular").postscriptName).toBe("YuGothic-Regular");
    expect(pickFace(faces, "bold").postscriptName).toBe("YuGothic-Bold");
  });

  it("UI派生しか無ければそれを使う", () => {
    expect(pickFace([faces[1]], "regular").index).toBe(1);
  });
});
