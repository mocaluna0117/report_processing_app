import { describe, expect, it } from "vitest";
import { HELP_SHOTS } from "@/lib/help-shots";
import { DENPYO_NOS, PEOPLE, cellsOf } from "../scripts/help-shots/fixtures";
import { findLeaks, assertLocal, parseArgs } from "../scripts/help-shots/run";
import { RECIPES } from "../scripts/help-shots/recipes";
import { COLUMNS } from "@/lib/tsv";

// 「使い方」ページの写真に、実在しうる値が入らないようにするテスト。
// ★写真そのものは目で見るしかないが、写すデータの形と、撮影の入口はここで固定する。

describe("写真に使う架空のデータ", () => {
  it("★氏名は架空のものだけ（実在の姓名を足せない形にする）", () => {
    for (const person of PEOPLE) {
      expect(person.name, person.name).toMatch(/^(山田　太郎|架空　.+)$/);
      expect(person.kana, person.kana).toMatch(/^(ヤマダ　タロウ|カクウ　.+)$/);
      expect(person.address, person.address).toContain("架空");
      expect(person.property, person.property).toContain("架空");
      expect(person.phone, person.phone).toMatch(/^0[89]0-0000-\d{4}$/);
      expect(person.pj, person.pj).toMatch(/^21012301\d\d$/);
    }
  });

  it("伝票№は架空の連番（9001〜9006）", () => {
    for (const no of DENPYO_NOS) expect(no).toMatch(/^900[1-6]$/);
  });

  it("行は転記先の列数どおり（画面の読み込みガードを通る）", () => {
    expect(cellsOf({ PJ: "2101230101" })).toHaveLength(COLUMNS.length);
    expect(cellsOf({ PJ: "2101230101" })[COLUMNS.indexOf("PJ")]).toBe("2101230101");
  });
});

describe("撮る前の見張り", () => {
  it("★社員番号の形・テナント・許可外の電話や氏名を見つける", () => {
    expect(findLeaks("担当 170013 さん")).toEqual(["社員番号の形: 170013"]);
    expect(findLeaks("https://example.rakurakuseisan.jp/")).toEqual(["テナントのホスト: rakurakuseisan.jp"]);
    expect(findLeaks("連絡先 03-1234-5678")).toEqual(["許可していない電話番号: 03-1234-5678"]);
    expect(findLeaks("施主 黒松　一郎 様")).toEqual(["氏名らしき文字列: 黒松　一郎"]);
  });

  it("架空のデータは通す", () => {
    const text = PEOPLE.map((p) => `${p.name} ${p.phone} ${p.address} ${p.pj}`).join("\n");
    expect(findLeaks(text)).toEqual([]);
    expect(findLeaks("顛末書№9001.pdf TE00009001 71,500 円")).toEqual([]);
  });

  it("★手元の開発サーバー以外は撮らない", () => {
    expect(() => assertLocal("http://127.0.0.1:3502")).not.toThrow();
    expect(() => assertLocal("http://localhost:3599")).not.toThrow();
    expect(() => assertLocal("https://folio.example.com")).toThrow();
  });

  it("引数の読み取り", () => {
    expect(parseArgs([])).toEqual({ only: [], base: null, format: "webp" });
    expect(parseArgs(["inspection-drop", "--format=png"])).toEqual({
      only: ["inspection-drop"],
      base: null,
      format: "png",
    });
    expect(parseArgs(["--base=http://127.0.0.1:3000"]).base).toBe("http://127.0.0.1:3000");
  });
});

describe("台本と文言の対応", () => {
  it("★台本と lib/help-shots.ts が同じ写真を指していて、印の数も合っている", () => {
    const declared = Object.values(HELP_SHOTS).flat();
    expect(RECIPES.map((r) => r.id).sort()).toEqual(declared.map((s) => s.id).sort());
    for (const shot of declared) {
      const recipe = RECIPES.find((r) => r.id === shot.id)!;
      expect(recipe.hotspots.length, shot.id).toBe(shot.hotspots.length);
    }
  });
});
