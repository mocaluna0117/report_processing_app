import { describe, expect, it } from "vitest";
import { AFTER_STEPS } from "@/lib/after/flow";
import { COMMON_FAQ, HELP_SECTIONS } from "@/lib/help";
import { INSPECTION_STEPS } from "@/lib/inspection-flow";
import { DOC_KINDS } from "@/lib/tenmatsu/kinds";
import { tenmatsuStepDefs } from "@/lib/tenmatsu/local/flow";

describe("「使い方」ページの中身", () => {
  it("画面の並びはタブと同じで、行き先も画面のURLと合っている", () => {
    // ★mode-nav.tsx は next/navigation を引くので、ここでは URL を直に書いて突き合わせる
    expect(HELP_SECTIONS.map((s) => s.href)).toEqual(["/", "/after", ...DOC_KINDS.map((k) => k.route)]);
  });

  it("節の目印は一意（目次のリンクが同じ場所を指さない）", () => {
    const ids = HELP_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("help-inspection");
    expect(ids).toContain("help-after");
    for (const kind of DOC_KINDS) expect(ids).toContain(`help-${kind.id}`);
  });

  it("★手順は各画面の規則をそのまま使う（画面の手順バーと言うことがずれない）", () => {
    expect(HELP_SECTIONS[0].steps).toBe(INSPECTION_STEPS);
    expect(HELP_SECTIONS[1].steps).toBe(AFTER_STEPS);
    DOC_KINDS.forEach((kind, i) => {
      expect(HELP_SECTIONS[2 + i].steps).toEqual(tenmatsuStepDefs(kind));
    });
  });

  it("どの節にも前置きと、つまずきが1つ以上ある", () => {
    for (const section of HELP_SECTIONS) {
      expect(section.title).not.toBe("");
      expect(section.intro.length).toBeGreaterThan(10);
      expect(section.faq.length).toBeGreaterThan(0);
      for (const item of section.faq) {
        expect(item.q).not.toBe("");
        expect(item.a.length).toBeGreaterThan(10);
      }
    }
    expect(COMMON_FAQ.length).toBeGreaterThan(0);
  });

  it("★押せない理由の説明が、画面ごとに必ずある", () => {
    for (const section of HELP_SECTIONS) {
      expect(section.faq.some((f) => f.q.includes("押せません"))).toBe(true);
    }
    expect(COMMON_FAQ.some((f) => f.q.includes("押せません"))).toBe(true);
  });

  it("定期点検にはファイル名の決まりが載っている", () => {
    const inspection = HELP_SECTIONS[0];
    expect(inspection.faq.some((f) => f.a.includes("【写真報告書】"))).toBe(true);
  });

  it("顛末書系にはログインのロックとフォルダーの許可が載っている", () => {
    for (const kind of DOC_KINDS) {
      const section = HELP_SECTIONS.find((s) => s.id === `help-${kind.id}`)!;
      expect(section.faq.some((f) => f.a.includes("ロック"))).toBe(true);
      expect(section.faq.some((f) => f.a.includes("許可"))).toBe(true);
    }
  });
});
