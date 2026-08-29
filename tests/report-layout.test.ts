import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { appendixSheet } from "@/lib/report/layout/appendix-sheet";
import { resolveGeometry, type Geometry, type Measure } from "@/lib/report/layout/grid";
import { MAIN_SHEET } from "@/lib/report/layout/main-sheet";
import { reportMeasure } from "./helpers/report-fonts";

/**
 * 見本PDFから抽出した罫線・固定ラベル・チェックボックスの位置
 * (tests/report-geometry.json / scripts/extract_report_geometry.py が生成) と
 * レイアウト計算の結果を突き合わせる。PDFの見た目が崩れたらここで落ちる。
 */
interface Rect {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  orientation: "h" | "v";
}
interface Label {
  text: string;
  x0: number;
  x1: number;
  baseline: number;
  size: number;
  bold: boolean;
}
interface Page {
  rects: Rect[];
  labels: Label[];
  checkboxes: { x0: number; top: number; size: number; codepoint: string }[];
}
const fixture = JSON.parse(
  readFileSync(join(process.cwd(), "tests", "report-geometry.json"), "utf8"),
) as { pages: { main: Page; appendix: Page } };

/** 二重下線は 0.6pt の細い矩形。罫線 (0.84/0.96/1.92/0.12) と区別する */
const isUnderlineRect = (r: Rect) => r.orientation === "h" && r.height > 0.5 && r.height < 0.7;

interface RefLine {
  position: number;
  from: number;
  to: number;
  thickness: number;
}
function refLines(page: Page, orientation: "h" | "v"): RefLine[] {
  return page.rects
    .filter((r) => r.orientation === orientation && !isUnderlineRect(r) && Math.min(r.width, r.height) < 3)
    .map((r) => ({
      position: orientation === "h" ? (r.top + r.bottom) / 2 : (r.x0 + r.x1) / 2,
      from: orientation === "h" ? r.x0 : r.top,
      to: orientation === "h" ? r.x1 : r.bottom,
      thickness: orientation === "h" ? r.height : r.width,
    }));
}

let measure: Measure;
let main: Geometry;
let appendix: Geometry;

beforeAll(async () => {
  const m = await reportMeasure();
  if (!m) {
    throw new Error(
      "public/report/fonts が未生成です。python3 scripts/build_report_fonts.py を実行してください",
    );
  }
  measure = m;
  main = resolveGeometry(MAIN_SHEET, {}, { "categories.inspection": true }, measure);
  const { spec, values } = appendixSheet({
    title: "1年目点検是正項目",
    propertyLine: "物件名：x",
    ownerLine: "施主名：x様",
    // 見本の別紙は6件。「対応結果：」の行数を合わせるためダミーを6件入れる
    items: Array.from({ length: 6 }, (_, i) => `項目${i + 1}`),
    pageLabel: "2/2",
  });
  appendix = resolveGeometry(spec, values, {}, measure);
});

/** 見本の線1本ごとに、計算結果の中で「位置・太さ・区間」が合う線を探す */
function expectLinesMatch(geometry: Geometry, page: Page) {
  for (const orientation of ["h", "v"] as const) {
    for (const ref of refLines(page, orientation)) {
      const label = `${orientation === "h" ? "横" : "縦"}罫線 ${ref.position.toFixed(2)} (${ref.from.toFixed(1)}〜${ref.to.toFixed(1)} 太さ${ref.thickness})`;
      const matched = geometry.lines.filter((l) => {
        const horizontal = l.y0 === l.y1;
        if (horizontal !== (orientation === "h")) return false;
        const position = horizontal ? l.y0 : l.x0;
        if (Math.abs(position - ref.position) > 0.5) return false;
        const from = horizontal ? Math.min(l.x0, l.x1) : Math.min(l.y0, l.y1);
        const to = horizontal ? Math.max(l.x0, l.x1) : Math.max(l.y0, l.y1);
        // 区間は見本を覆っていること (端の丸めの違いを 1.5pt まで許容)
        return from <= ref.from + 1.5 && to >= ref.to - 1.5;
      });
      expect(matched.length, label).toBeGreaterThan(0);
      expect(
        matched.some((l) => Math.abs(l.width - ref.thickness) < 0.35),
        `${label} の太さ`,
      ).toBe(true);
    }
  }
}

/** 計算結果の線が、見本のどの線にも対応していない (= 余計な線) ことがないか */
function expectNoStrayLines(geometry: Geometry, page: Page) {
  for (const line of geometry.lines) {
    const horizontal = line.y0 === line.y1;
    const position = horizontal ? line.y0 : line.x0;
    const refs = refLines(page, horizontal ? "h" : "v");
    const near = refs.filter(
      (r) => Math.abs(r.position - position) < 0.5 && Math.abs(r.thickness - line.width) < 0.35,
    );
    expect(
      near.length,
      `見本に無い${horizontal ? "横" : "縦"}罫線 ${position.toFixed(2)} (太さ${line.width.toFixed(2)})`,
    ).toBeGreaterThan(0);
  }
  // 本数も見本以下 (区間がつながって1本になることはある)
  expect(geometry.lines.length).toBeLessThanOrEqual(refLines(page, "h").length + refLines(page, "v").length);
}

const drawn = (geometry: Geometry, text: string) => geometry.texts.filter((t) => t.text === text);

/** ラベルの位置を見本と比べる。フォントが違うので幅に依存する量は緩めに見る */
function expectLabel(geometry: Geometry, ref: Label, align: "left" | "right" | "center" = "left") {
  const found = drawn(geometry, ref.text);
  expect(found.length, `${ref.text} の描画数`).toBe(1);
  const [t] = found;
  const width = measure(t.text, t.size, t.bold);
  if (align === "left") {
    expect(Math.abs(t.x - ref.x0), `${ref.text} の左端`).toBeLessThan(0.7);
  } else if (align === "right") {
    expect(Math.abs(t.x + width - ref.x1), `${ref.text} の右端`).toBeLessThan(2.5);
  } else {
    const center = (ref.x0 + ref.x1) / 2;
    expect(Math.abs(t.x + width / 2 - center), `${ref.text} の中心`).toBeLessThan(3.5);
  }
  expect(Math.abs(t.baseline - ref.baseline), `${ref.text} のベースライン`).toBeLessThan(0.6);
  expect(Math.abs(t.size - ref.size), `${ref.text} の文字サイズ`).toBeLessThan(0.3);
  expect(t.bold, `${ref.text} の太字`).toBe(ref.bold);
}

const label = (page: Page, text: string, index = 0) =>
  page.labels.filter((l) => l.text === text)[index];

describe("本紙のレイアウト", () => {
  it("罫線が見本PDFと一致する (位置・太さ・区間)", () => {
    expectLinesMatch(main, fixture.pages.main);
  });

  it("見本に無い罫線を引いていない", () => {
    expectNoStrayLines(main, fixture.pages.main);
  });

  it("左寄せの固定ラベルが見本と一致する", () => {
    for (const text of [
      "PJコード",
      "引渡日",
      "物件名",
      "施主名",
      "住所",
      "連絡先①",
      "連絡先②",
      "立会",
      "施主",
      "施主ご家族",
      "受付項目",
      "点検",
      "アフター",
      "有償工事",
      "直収対応",
      "無償対応",
      "受付日",
      "受付者",
      "指示内容",
      "作業内容・是正内容",
      "◎上記作業内容もしくは是正工事が完了したことを確認しました。",
    ]) {
      const ref = label(fixture.pages.main, text);
      expect(ref, `見本に ${text} がある`).toBeDefined();
      // 「その他（　…）」「会社名：　…」のように、ラベルと空白が1セルに入っているものは
      // 前方一致で比べる (見本側は空白が字形として出ないため)
      const cell =
        main.texts.find((t) => t.text === text) ?? main.texts.find((t) => t.text.startsWith(text));
      expect(cell, `${text} の描画`).toBeDefined();
      expect(Math.abs(cell!.x - ref.x0), `${text} の左端`).toBeLessThan(0.7);
      expect(Math.abs(cell!.baseline - ref.baseline), `${text} のベースライン`).toBeLessThan(0.6);
    }
  });

  it("右寄せの社名・日付欄が右端で揃う", () => {
    expectLabel(main, label(fixture.pages.main, "タカマツビルド　株式会社"), "right");
    expectLabel(main, label(fixture.pages.main, "アフターメンテナンス課"), "right");
  });

  it("ページヘッダーのタイトルが太字で左上に入る", () => {
    expectLabel(main, label(fixture.pages.main, "作業報告書　兼　完了報告書"));
  });

  it("完了ﾁｪｯｸの見出しが中央に入る (10pt)", () => {
    expectLabel(main, label(fixture.pages.main, "完了ﾁｪｯｸ"), "center");
  });

  it("チェックボックスの位置・大きさが見本と一致し、点検だけチェック済み", () => {
    const refs = fixture.pages.main.checkboxes;
    expect(main.checkboxes).toHaveLength(refs.length);
    const sorted = [...main.checkboxes].sort((a, b) => a.y - b.y || a.x - b.x);
    refs.forEach((ref, i) => {
      expect(Math.abs(sorted[i].x - ref.x0), `checkbox${i} の左端`).toBeLessThan(0.6);
      expect(Math.abs(sorted[i].y - ref.top), `checkbox${i} の上端`).toBeLessThan(0.6);
      expect(Math.abs(sorted[i].size - ref.size), `checkbox${i} の大きさ`).toBeLessThan(0.3);
      // 見本ではチェック済みだけ字形が違う (U+E259)
      expect(sorted[i].checked, `checkbox${i} のチェック`).toBe(ref.codepoint === "U+E259");
    });
  });

  it("二重下線が3箇所 (会社名・作業者・お客様ご署名) に入る", () => {
    // 1箇所につき2本
    expect(main.underlines).toHaveLength(6);
    const refs = fixture.pages.main.rects.filter(isUnderlineRect);
    expect(refs).toHaveLength(6);
    const sorted = [...main.underlines].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const sortedRefs = [...refs].sort((a, b) => a.top - b.top || a.x0 - b.x0);
    sortedRefs.forEach((ref, i) => {
      expect(Math.abs(sorted[i].x0 - ref.x0), `下線${i} の左端`).toBeLessThan(0.7);
      expect(Math.abs(sorted[i].x1 - ref.x1), `下線${i} の右端`).toBeLessThan(3);
      expect(Math.abs(sorted[i].y0 - ref.top), `下線${i} の位置`).toBeLessThan(0.6);
    });
  });
});

describe("別紙のレイアウト", () => {
  it("罫線が見本PDFと一致する (項目行の極細線を含む)", () => {
    expectLinesMatch(appendix, fixture.pages.appendix);
  });

  it("見本に無い罫線を引いていない", () => {
    expectNoStrayLines(appendix, fixture.pages.appendix);
  });

  it("見出し・タイトルの位置が見本と一致する", () => {
    expectLabel(appendix, label(fixture.pages.appendix, "（別　紙）"));
    expectLabel(appendix, label(fixture.pages.appendix, "1年目点検是正項目"));
    expectLabel(appendix, label(fixture.pages.appendix, "項　　　目"), "center");
    expectLabel(appendix, label(fixture.pages.appendix, "チェック欄"));
    expectLabel(appendix, label(fixture.pages.appendix, "2/2"), "right");
  });

  it("「対応結果：」が項目のある行だけに入る", () => {
    const refs = fixture.pages.appendix.labels.filter((l) => l.text === "対応結果：");
    const found = drawn(appendix, "対応結果：");
    expect(found).toHaveLength(refs.length);
    refs.forEach((ref, i) => {
      expect(Math.abs(found[i].x - ref.x0), `対応結果[${i}] の左端`).toBeLessThan(0.7);
      expect(Math.abs(found[i].baseline - ref.baseline), `対応結果[${i}] のベースライン`).toBeLessThan(0.6);
    });
  });

  it("見出し行に薄青の塗りが入る", () => {
    expect(appendix.fills).toHaveLength(2);
    expect(appendix.fills[0].color).toBe("#BDD7EE");
    const ref = fixture.pages.appendix.rects.find((r) => r.height > 10 && r.height < 20);
    expect(Math.abs(appendix.fills[0].y0 - ref!.top)).toBeLessThan(0.6);
    expect(Math.abs(appendix.fills[0].y1 - ref!.bottom)).toBeLessThan(0.6);
  });
});
