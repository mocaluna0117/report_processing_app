import { describe, expect, it } from "vitest";
import { pairFiles, parseFileName } from "@/lib/pairing";

// 実運用と同じ命名パターンの10ファイル名 (氏名は架空)。
// 実ファイルで確認した揺れを再現: 全角スペース・末尾「 .PDF」・「  (1)」・「 _ 」混在
const SAMPLE_NAMES = [
  "20260704 【写真報告書】佐藤　一郎様邸 .PDF",
  "20260712 【写真報告書】鈴木　次郎様邸 .PDF",
  "20260722 【写真報告書】高橋　良子様邸 .PDF",
  "20260730 【写真報告書】王　建明様邸  (1).PDF",
  "20260823 【写真報告書】中村 _ 光様邸 .PDF",
  "20260704 【点検報告書】佐藤　一郎様邸 .PDF",
  "20260712 【点検報告書】鈴木　次郎様邸 .PDF",
  "20260722 【点検報告書】高橋　良子様邸 .PDF",
  "20260730 【点検報告書】王　建明様邸 .PDF",
  "20260823 【点検報告書】中村 _ 光様邸 .PDF",
];

describe("parseFileName", () => {
  it("種別・日付・施主名を分解する", () => {
    const p = parseFileName("20260722 【写真報告書】高橋　良子様邸 .PDF");
    expect(p.kind).toBe("photo");
    expect(p.date).toBe("20260722");
    expect(p.ownerKey).toBe("高橋良子");
    expect(p.ownerDisplay).toBe("高橋 良子");
  });

  it("「 (1)」サフィックスと末尾スペースを除去する", () => {
    const p = parseFileName("20260730 【写真報告書】王　建明様邸  (1).PDF");
    expect(p.kind).toBe("photo");
    expect(p.date).toBe("20260730");
    expect(p.ownerKey).toBe("王建明");
  });

  it("スペース+アンダースコア混在を正規化する", () => {
    const p = parseFileName("20260823 【点検報告書】中村 _ 光様邸 .PDF");
    expect(p.kind).toBe("inspection");
    expect(p.ownerKey).toBe("中村光");
  });

  it("macOSのNFD (濁点分解) でも同じキーになる", () => {
    const nfc = parseFileName("20260101 【写真報告書】ガーデン　太郎様邸.pdf");
    const nfd = parseFileName(
      "20260101 【写真報告書】ガーデン　太郎様邸.pdf".normalize("NFD"),
    );
    expect(nfd.ownerKey).toBe(nfc.ownerKey);
  });

  it("報告書以外のファイルは kind=null", () => {
    expect(parseFileName("請求書_202607.pdf").kind).toBeNull();
  });
});

describe("pairFiles", () => {
  it("10ファイルが5ペアに完全一致で組める (「 (1)」付きを含む)", () => {
    const files = SAMPLE_NAMES.map((name, i) => ({ id: `f${i}`, name }));
    const { pairs, unclassified } = pairFiles(files);
    expect(unclassified).toHaveLength(0);
    expect(pairs).toHaveLength(5);
    for (const pair of pairs) {
      expect(pair.photo, `${pair.ownerDisplay} の写真報告書`).not.toBeNull();
      expect(pair.inspection, `${pair.ownerDisplay} の点検報告書`).not.toBeNull();
      expect(pair.needsReview).toBe(false);
    }
  });

  it("完全一致しない氏名は同一日付内の曖昧マッチで needsReview 付きペアになる", () => {
    const { pairs } = pairFiles([
      { id: "a", name: "20260722 【写真報告書】高橋　良子様邸.pdf" },
      { id: "b", name: "20260722 【点検報告書】高橋　良子様.pdf" }, // 「邸」なし → 正規化で一致
      { id: "c", name: "20260722 【写真報告書】山田　花子様邸.pdf" },
      { id: "d", name: "20260722 【点検報告書】山田　花様邸.pdf" }, // 1文字違い
    ]);
    const yamada = pairs.find((p) => p.ownerDisplay.includes("山田"));
    expect(yamada?.inspection?.id).toBe("d");
    expect(yamada?.needsReview).toBe(true);
  });

  it("同一日付でも別世帯 (名が異なる) は誤ペアしない", () => {
    const { pairs } = pairFiles([
      { id: "a", name: "20260722 【写真報告書】山田　太郎様邸.pdf" },
      { id: "b", name: "20260722 【点検報告書】山田　花子様邸.pdf" }, // 同姓別名 (距離2)
    ]);
    const yamada = pairs.find((p) => p.photo?.id === "a");
    expect(yamada?.inspection).toBeNull();
  });

  it("同一日付でも姓が異なる1文字違いは誤ペアしない", () => {
    const { pairs } = pairFiles([
      { id: "a", name: "20260722 【写真報告書】王様邸.pdf" },
      { id: "b", name: "20260722 【点検報告書】玉様邸.pdf" }, // 距離1だが別姓
      { id: "c", name: "20260722 【写真報告書】鈴木　次郎様邸.pdf" },
      { id: "d", name: "20260722 【点検報告書】中村　次郎様邸.pdf" }, // 距離2・別姓
    ]);
    for (const p of pairs.filter((x) => x.photo)) {
      expect(p.inspection, `${p.ownerDisplay} が誤ペアされた`).toBeNull();
    }
  });

  it("相手のいない点検報告書も行として残る", () => {
    const { pairs } = pairFiles([
      { id: "a", name: "20260722 【点検報告書】高橋　良子様邸.pdf" },
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].photo).toBeNull();
    expect(pairs[0].inspection?.id).toBe("a");
  });
});
