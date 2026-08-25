import { describe, expect, it } from "vitest";
import { HEADER_ROWS, SLOT } from "@/lib/pdf/constants";
import { parsePhotoReport } from "@/lib/pdf/parse-photo-report";
import type { TextToken } from "@/lib/types";

// --- 合成トークンのヘルパー (実測座標に合わせる) ---

const t = (str: string, x: number, y: number, page = 1): TextToken => ({
  str,
  x,
  y,
  page,
});

function headerTokens(overrides?: { siteName?: string }): TextToken[] {
  return [
    t("9900110101", 65.94, HEADER_ROWS.rowA),
    t(overrides?.siteName ?? "【サンプルハウス】999.杉並区高円寺北1-2-4Ａ号棟", 242.79, HEADER_ROWS.rowA),
    t("2025", 451.86, HEADER_ROWS.rowA),
    t("9", 493.83, HEADER_ROWS.rowA),
    t("26", 519.68, HEADER_ROWS.rowA),
    t("東京都杉並区高円寺北1-2-3", 45.71, HEADER_ROWS.rowB),
    t("2026", 451.86, HEADER_ROWS.rowB),
    t("7", 493.83, HEADER_ROWS.rowB),
    t("22", 519.68, HEADER_ROWS.rowB),
    t("高橋", 56.2, HEADER_ROWS.rowC),
    t("良子 様", 87.67, HEADER_ROWS.rowC),
    t("1年", 360.82, HEADER_ROWS.rowC),
    t("佐々木", 483.34, HEADER_ROWS.rowC), // 点検員 (抽出対象外)
    t("異常なし", 130.01, 233.05),
  ];
}

/** スロット内の各欄に実測相対座標でトークンを置く */
function slotTokens(
  page: number,
  slot: number,
  fields: Partial<{
    location: [string, string];
    part: [string, string];
    symptom: string;
    response: string;
    tempFeel: string;
    followup: string;
    remarks: string[];
  }>,
): TextToken[] {
  const top = SLOT.top + slot * SLOT.pitch;
  const line1 = top + SLOT.firstLineOffset; // 実測 dy=0
  const out: TextToken[] = [];
  if (fields.location) {
    out.push(t(fields.location[0], 65, line1, page));
    out.push(t(fields.location[1], 63, line1 + 12, page));
  }
  if (fields.part) {
    out.push(t(fields.part[0], 138, line1, page));
    out.push(t(fields.part[1], 146, line1 + 12, page));
  }
  if (fields.symptom) out.push(t(fields.symptom, 94, line1 + 45.7, page));
  if (fields.response) out.push(t(fields.response, 58, line1 + 83.9, page));
  if (fields.tempFeel) out.push(t(fields.tempFeel, 144, line1 + 83.9, page));
  if (fields.followup) out.push(t(fields.followup, 86, line1 + 123.6, page));
  fields.remarks?.forEach((line, i) =>
    out.push(t(line, 33.72, line1 + 157.4 + i * 11.24, page)),
  );
  return out;
}

describe("parsePhotoReport: ヘッダ", () => {
  it("8項目すべてを抽出する", () => {
    const r = parsePhotoReport(headerTokens(), 1);
    expect(r.pj.value).toBe("9900110101");
    expect(r.developer.value).toBe("サンプルハウス");
    expect(r.propertyName.value).toBe("999.杉並区高円寺北1-2-4Ａ号棟");
    expect(r.handoverDate.value).toBe("2025/09/26"); // ゼロ埋め
    expect(r.inspectionDate.value).toBe("2026/07/22");
    expect(r.address.value).toBe("東京都杉並区高円寺北1-2-3");
    expect(r.ownerName.value).toBe("高橋 良子"); // 「様」除去
    expect(r.inspectionTiming.value).toBe("1年");
    expect(r.noAbnormalityOnPage1).toBe(true);
    expect(r.templateRecognized).toBe(true);
    for (const f of [r.pj, r.developer, r.propertyName, r.handoverDate, r.address, r.ownerName, r.inspectionTiming]) {
      expect(f.confidence).toBe("ok");
    }
  });

  it("【】の無い現場名は事業者=空欄・物件名称=全文 (confidence ok)", () => {
    const r = parsePhotoReport(headerTokens({ siteName: "本町・鈴木様アパート" }), 1);
    expect(r.developer.value).toBe("");
    expect(r.developer.confidence).toBe("ok");
    expect(r.propertyName.value).toBe("本町・鈴木様アパート");
  });

  it("点検時期の「か月」表記を「ヶ月」へ正規化する", () => {
    const tokens = headerTokens().map((tok) =>
      tok.str === "1年" ? { ...tok, str: "3か月" } : tok,
    );
    const r = parsePhotoReport(tokens, 1);
    expect(r.inspectionTiming.value).toBe("3ヶ月");
    expect(r.inspectionTiming.confidence).toBe("ok");
  });

  it("日付が「2026 10 26」の結合1トークンで来ても抽出でき、現場名に混入しない", () => {
    const tokens = headerTokens().filter(
      (tok) => !(tok.y === HEADER_ROWS.rowA && /^\d+$/.test(tok.str)),
    );
    tokens.push(t("2026 10 26", 451.86, HEADER_ROWS.rowA));
    const r = parsePhotoReport(tokens, 1);
    expect(r.handoverDate.value).toBe("2026/10/26");
    expect(r.propertyName.value).toBe("999.杉並区高円寺北1-2-4Ａ号棟");
  });

  it("契約番号が既定位置に無ければページ内検索でwarn付き取得", () => {
    const tokens = headerTokens().map((tok) =>
      tok.str === "9900110101" ? { ...tok, y: 300 } : tok,
    );
    const r = parsePhotoReport(tokens, 1);
    expect(r.pj.value).toBe("9900110101");
    expect(r.pj.confidence).toBe("warn");
  });

  it("点検日がファイル名の日付と不一致ならwarn", () => {
    const r = parsePhotoReport(headerTokens(), 1, { fileNameDate: "20260723" });
    expect(r.inspectionDate.confidence).toBe("warn");
    expect(r.inspectionDate.warnings.join("")).toContain("一致しません");
  });

  it("契約番号も日付も無いテキストは未知テンプレートとして全欄fail", () => {
    const r = parsePhotoReport([t("ただのメモ書き", 100, 400)], 1);
    expect(r.templateRecognized).toBe(false);
    expect(r.pj.confidence).toBe("fail");
    expect(r.ownerName.value).toBe("");
    expect(r.defects).toHaveLength(0);
  });
});

describe("parsePhotoReport: 不具合ブロック", () => {
  const header = headerTokens();

  it("通常ブロックを構造化する (空スロットはスキップ)", () => {
    const tokens = [
      ...header,
      ...slotTokens(2, 0, {
        location: ["1階", "洋室"],
        part: ["クロス", "壁"],
        symptom: "のり汚れ",
        response: "是正不可",
        tempFeel: "普通",
        followup: "弊社継続対応",
        remarks: ["継ぎ目ののり汚れについて", "補修をご希望です。"],
      }),
      // slot1, slot2 は空
    ];
    const r = parsePhotoReport(tokens, 2);
    expect(r.defects).toHaveLength(1);
    const d = r.defects[0];
    expect(d.location).toBe("1階 洋室");
    expect(d.part).toBe("クロス 壁");
    expect(d.symptom).toBe("のり汚れ");
    expect(d.tempFeel).toBe("普通");
    expect(d.followup).toBe("弊社継続対応");
    expect(d.remarks).toBe("継ぎ目ののり汚れについて補修をご希望です。");
  });

  it("備考のみの継続ブロックを直前ブロックへ連結し「次頁に続く」を除去する", () => {
    const tokens = [
      ...header,
      ...slotTokens(2, 0, {
        location: ["1階", "洋室"],
        part: ["クロス", "壁"],
        symptom: "のり汚れ",
        remarks: ["気になるとのことで", "次頁に続く"],
      }),
      ...slotTokens(2, 1, { remarks: ["補修をご希望です。"] }),
    ];
    const r = parsePhotoReport(tokens, 2);
    expect(r.defects).toHaveLength(1);
    expect(r.defects[0].remarks).toBe("気になるとのことで補修をご希望です。");
  });

  it("ページをまたぐ継続ブロックも直前ブロックへ連結する", () => {
    const tokens = [
      ...header,
      ...slotTokens(2, 2, {
        location: ["2階", "リビング"],
        part: ["クロス", "壁"],
        symptom: "浮き",
        remarks: ["下地の不陸が原因と思われ", "次頁に続く"],
      }),
      ...slotTokens(3, 0, { remarks: ["ます。補修対応をご要望です。"] }),
    ];
    const r = parsePhotoReport(tokens, 3);
    expect(r.defects).toHaveLength(1);
    expect(r.defects[0].remarks).toBe("下地の不陸が原因と思われます。補修対応をご要望です。");
  });

  it("【特記事項】はspecialNotesへ、直前ブロックの無い備考のみはstandaloneNotesへ", () => {
    const tokens = [
      ...header,
      ...slotTokens(2, 0, { remarks: ["サイン、立ち会い、番号は管理者様になります。"] }),
      ...slotTokens(2, 2, {
        remarks: ["【特記事項】", "点検後にご申告あり。是正ご希望です。"],
      }),
    ];
    const r = parsePhotoReport(tokens, 2);
    expect(r.defects).toHaveLength(0);
    expect(r.standaloneNotes).toEqual([
      "サイン、立ち会い、番号は管理者様になります。",
    ]);
    expect(r.specialNotes).toEqual(["点検後にご申告あり。是正ご希望です。"]);
  });

  it("備考が下端まで伸びても次スロットの場所と混ざらない", () => {
    const tokens = [
      ...header,
      ...slotTokens(2, 0, {
        location: ["1階", "洋室"],
        part: ["クロス", "壁"],
        symptom: "凹凸",
        remarks: ["a", "b", "c", "d", "e"], // 5行 (最下行 dy≈202)
      }),
      ...slotTokens(2, 1, {
        location: ["2階", "廊下"],
        part: ["大工", "床"],
        symptom: "きしみ",
      }),
    ];
    const r = parsePhotoReport(tokens, 2);
    expect(r.defects).toHaveLength(2);
    expect(r.defects[0].remarks).toBe("abcde");
    expect(r.defects[1].location).toBe("2階 廊下");
  });
});
