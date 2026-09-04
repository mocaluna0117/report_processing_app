import { describe, expect, it } from "vitest";
import { formatDefectList } from "@/lib/summarize/defects";

const defect = (over: Partial<Parameters<typeof formatDefectList>[0]["defects"][number]> = {}) => ({
  location: "1階 洋室",
  part: "クロス 天井",
  symptom: "凹凸",
  followup: "弊社継続対応",
  remarks: "",
  ...over,
});

describe("formatDefectList", () => {
  it("場所・部位・症状を番号付きで並べる", () => {
    const text = formatDefectList({ defects: [defect(), defect({ symptom: "浮き" })], specialNotes: [] });
    expect(text).toBe(
      "1. 場所: 1階 洋室 / 部位: クロス 天井 / 症状: 凹凸\n" +
        "2. 場所: 1階 洋室 / 部位: クロス 天井 / 症状: 浮き",
    );
  });

  it("事後対応 (対応方針) は載せない", () => {
    const text = formatDefectList({ defects: [defect()], specialNotes: [] });
    expect(text).not.toContain("弊社継続対応");
  });

  it("空の項目は - で埋める", () => {
    const text = formatDefectList({
      defects: [defect({ location: "", part: "", symptom: "" })],
      specialNotes: [],
    });
    expect(text).toBe("1. 場所: - / 部位: - / 症状: -");
  });

  it("備考は伏せ字にしてから載せる", () => {
    const text = formatDefectList({
      defects: [defect({ remarks: "山田様より連絡。090-0000-1234。下地の不陸によるもの" })],
      specialNotes: [],
    });
    expect(text).toContain("備考");
    expect(text).toContain("下地の不陸によるもの");
    expect(text).not.toContain("山田");
    expect(text).not.toContain("090-0000-1234");
  });

  it("特記事項も伏せ字にして並べる", () => {
    const text = formatDefectList({
      defects: [],
      specialNotes: ["東京都架空区北町1-2-3 の外構にひび"],
    });
    expect(text).toContain("## 特記事項");
    expect(text).toContain("外構にひび");
    expect(text).not.toContain("架空区北町");
  });

  it("不具合が0件なら指摘なしと書く", () => {
    expect(formatDefectList({ defects: [], specialNotes: [] })).toBe("(不具合の指摘なし)");
  });
});
