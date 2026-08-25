import { describe, expect, it } from "vitest";
import { buildMergedPdfName } from "@/lib/naming";

describe("buildMergedPdfName", () => {
  it("「〇〇目点検報告書_施主名様／物件名.pdf」形式で組み立てる (姓名間は半角スペース)", () => {
    expect(
      buildMergedPdfName({
        timing: "1年",
        ownerName: "山田 太郎",
        propertyName: "999.杉並区高円寺北1-2-4A号棟",
      }),
    ).toBe("1年目点検報告書_山田 太郎様／999.杉並区高円寺北1-2-4A号棟.pdf");
  });

  it("3ヶ月点検の場合", () => {
    expect(
      buildMergedPdfName({
        timing: "3ヶ月",
        ownerName: "鈴木 花子",
        propertyName: "サンプルタウン1丁目3号地",
      }),
    ).toBe("3ヶ月目点検報告書_鈴木 花子様／サンプルタウン1丁目3号地.pdf");
  });

  it("点検時期が抽出できない場合は「点検報告書_…」", () => {
    expect(
      buildMergedPdfName({ ownerName: "山田 太郎", propertyName: "物件A" }),
    ).toBe("点検報告書_山田 太郎様／物件A.pdf");
  });

  it("物件名が無い場合は「／物件名」を省略する", () => {
    expect(buildMergedPdfName({ timing: "1年", ownerName: "山田 太郎" })).toBe(
      "1年目点検報告書_山田 太郎様.pdf",
    );
  });

  it("施主名が抽出できなければファイル名由来の氏名で代替、それも無ければ施主不明", () => {
    expect(
      buildMergedPdfName({ timing: "1年", fallbackOwner: "山田 太郎" }),
    ).toBe("1年目点検報告書_山田 太郎様.pdf");
    expect(buildMergedPdfName({ timing: "1年" })).toBe(
      "1年目点検報告書_施主不明.pdf",
    );
  });

  it("ファイル名に使えない文字は全角へ置換される", () => {
    expect(
      buildMergedPdfName({
        timing: "1年",
        ownerName: "山田 太郎",
        propertyName: "A棟/B棟:計2棟",
      }),
    ).toBe("1年目点検報告書_山田 太郎様／A棟／B棟：計2棟.pdf");
  });
});
