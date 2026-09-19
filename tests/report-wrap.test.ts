import { describe, expect, it } from "vitest";
import { charUnits, wrapText } from "@/lib/report/wrap";
import { MAIN_LINE_UNITS } from "@/lib/report/model";

/** 本紙の指示内容の枠と同じ幅 (全角41文字) */
const wrap = (text: string, width = MAIN_LINE_UNITS) => wrapText(text, width);
const repeat = (n: number, ch = "あ") => ch.repeat(n);

/** 実際に出た56文字の項目 (架空の文面ではなく、利用者が入れた工事の状況) */
const LONG =
  "基礎の巾木仕上げ施工時に土台水切りや通気パッキン周辺の通気スリットまで塗り込まれて隙間が閉塞・阻害されている状況";

describe("charUnits", () => {
  it("全角は1・半角は0.5 として数える", () => {
    expect(charUnits("あいう")).toBe(3);
    expect(charUnits("ABcd12")).toBe(3);
    expect(charUnits("ｱｲｳ")).toBe(1.5);
    expect(charUnits("")).toBe(0);
  });
});

describe("wrapText", () => {
  it("幅に入る文は1行のまま", () => {
    expect(wrap(repeat(41))).toEqual([repeat(41)]);
  });

  it("★入らない文は次の行へ折り返す (文字は落とさない)", () => {
    const text = repeat(42);
    const lines = wrap(text);
    expect(lines).toHaveLength(2);
    expect(lines.join("")).toBe(text);
    for (const line of lines) expect(charUnits(line)).toBeLessThanOrEqual(MAIN_LINE_UNITS);
  });

  it("★実際に出た56文字の項目は「…塗り込まれて」で折り返す (画面の見本と同じ位置)", () => {
    const lines = wrap(LONG);
    expect(lines).toEqual([
      "基礎の巾木仕上げ施工時に土台水切りや通気パッキン周辺の通気スリットまで塗り込まれて",
      "隙間が閉塞・阻害されている状況",
    ]);
    expect(lines.join("")).toBe(LONG);
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
