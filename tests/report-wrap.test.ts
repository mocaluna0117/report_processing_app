import { describe, expect, it } from "vitest";
import type { Measure } from "@/lib/report/layout/grid";
import { planMainRows, wrapText } from "@/lib/report/layout/wrap";

/** 作り物の計測: 全角は size、半角は size/2 */
const measure: Measure = (text, size) => {
  let w = 0;
  for (const ch of text) w += /[\x20-\x7e]/.test(ch) ? size / 2 : size;
  return w;
};

const SIZE = 11.04;
/** ちょうど全角41文字が入る幅 (本紙の指示内容と同じ勘定) */
const WIDTH = SIZE * 41;
const wrap = (text: string, width = WIDTH) => wrapText(text, width, SIZE, false, measure);
const repeat = (n: number, ch = "あ") => ch.repeat(n);

describe("wrapText", () => {
  it("幅に入る文は1行のまま", () => {
    expect(wrap(repeat(41))).toEqual([repeat(41)]);
  });

  it("★入らない文は次の行へ折り返す (文字は落とさない)", () => {
    const text = repeat(42);
    const lines = wrap(text);
    expect(lines).toHaveLength(2);
    expect(lines.join("")).toBe(text);
    for (const line of lines) expect(measure(line, SIZE, false)).toBeLessThanOrEqual(WIDTH + 0.01);
  });

  it("★実際に出た56文字の項目が2行に入る", () => {
    const text =
      "基礎の巾木仕上げ施工時に土台水切りや通気パッキン周辺の通気スリットまで塗り込まれて隙間が閉塞・阻害されている状況";
    const lines = wrap(text);
    expect(lines.length).toBe(2);
    expect(lines.join("")).toBe(text);
  });

  it("空文字は行を作らない", () => {
    expect(wrap("")).toEqual([]);
    expect(wrap("   ")).toEqual([]);
  });

  it("★行頭に句読点・閉じ括弧を置かない", () => {
    // 41文字目が「、」になる並び
    const lines = wrap(`${repeat(40)}、${repeat(10)}`);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines.slice(1)) expect("、。）」").not.toContain(line[0]);
  });

  it("★行末に開き括弧を置かない", () => {
    const lines = wrap(`${repeat(40)}（${repeat(10)}）`);
    for (const line of lines) expect("（「『").not.toContain(line[line.length - 1]);
  });

  it("★英数字の連続は途中で切らない", () => {
    const lines = wrap(`${repeat(38)}ABCDEFGH`);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("ABCDEFGH");
  });

  it("1行より長い英数字だけは文字で切る (無限に伸ばさない)", () => {
    const lines = wrap("A".repeat(200));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("A".repeat(200));
  });
});

describe("planMainRows", () => {
  const linesOf = (text: string) => wrap(text);
  const item = (no: string, text: string) => ({ no, text });

  it("1行の項目は5件まで枠に収まる", () => {
    const rows = planMainRows(
      [1, 2, 3, 4, 5].map((i) => item(`(${i})`, repeat(10))),
      linesOf,
    );
    expect(rows?.map((r) => [r.rowStart, r.rowSpan])).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
    ]);
  });

  it("★2行になる項目は枠を2つ使い、次の項目はその下から始まる", () => {
    const rows = planMainRows([item("①", repeat(50)), item("②", repeat(10))], linesOf);
    expect(rows?.map((r) => [r.rowStart, r.rowSpan])).toEqual([
      [0, 2],
      [2, 1],
    ]);
    expect(rows?.[0].lines).toHaveLength(2);
  });

  it("★合計が5行を超えたら null (呼ぶ側が別紙に回す)", () => {
    expect(planMainRows([1, 2, 3].map(() => item("①", repeat(50))), linesOf)).toBeNull();
    expect(planMainRows([item("①", repeat(50))], linesOf, 1)).toBeNull();
  });

  it("空の項目でも1枠は使う", () => {
    const rows = planMainRows([item("①", "")], linesOf);
    expect(rows?.[0]).toMatchObject({ rowStart: 0, rowSpan: 1, lines: [""] });
  });
});
