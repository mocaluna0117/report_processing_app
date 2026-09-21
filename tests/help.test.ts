import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AFTER_STEPS } from "@/lib/after/flow";
import { COMMON_FAQ, HELP_SECTIONS } from "@/lib/help";
import { HELP_SHOTS, helpShotSrc } from "@/lib/help-shots";
import { HELP_SHOT_GEOMETRY } from "@/lib/help-shots.generated";
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

  it("★画面のフッターを消したぶん、Gemini へ送るものが使い方に載っている", () => {
    for (const id of ["help-inspection", "help-after"]) {
      const section = HELP_SECTIONS.find((s) => s.id === id)!;
      const answers = section.faq.map((f) => f.a).join("");
      expect(answers).toContain("Gemini API");
      expect(answers).toContain("APIキーが未設定");
    }
  });

  it("★段の説明は短く保つ（画面の手順バーと同じ文を使うため）", () => {
    for (const section of HELP_SECTIONS) {
      for (const step of section.steps) {
        expect(step.description.length, `${section.title} / ${step.label}`).toBeLessThanOrEqual(70);
      }
    }
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

  it("★写真は next/image を使わない（認証の外に出さないため）", () => {
    // proxy.ts の matcher は /_next/image と /_next/static を素通しにしている。
    // そこに社内画面の写真を置くと、APP_PASSWORD の保護が効かない。
    const page = readFileSync("app/help/page.tsx", "utf8");
    // （理由はページの冒頭コメントに書いてあるので、import だけを見る）
    expect(page).not.toMatch(/from\s+["']next\/image["']/);
    expect(page).toContain("<img");
  });

  it("顛末書系にはログインのロックとフォルダーの許可が載っている", () => {
    for (const kind of DOC_KINDS) {
      const section = HELP_SECTIONS.find((s) => s.id === `help-${kind.id}`)!;
      expect(section.faq.some((f) => f.a.includes("ロック"))).toBe(true);
      expect(section.faq.some((f) => f.a.includes("許可"))).toBe(true);
    }
  });
});

describe("使い方ページの画面写真", () => {
  const shots = HELP_SECTIONS.flatMap((section) => section.shots.map((shot) => ({ section, shot })));

  it("写真の束は、実在する節にだけ結び付いている", () => {
    const ids = new Set(HELP_SECTIONS.map((s) => s.id));
    for (const key of Object.keys(HELP_SHOTS)) expect(ids, key).toContain(key);
    for (const section of HELP_SECTIONS) expect(section.shots).toBe(HELP_SHOTS[section.id] ?? section.shots);
  });

  it("★写真の目印は一意で、節の名前で始まる（ファイル名がぶつからない）", () => {
    const ids = shots.map(({ shot }) => shot.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { section, shot } of shots) {
      expect(shot.id, shot.id).toMatch(new RegExp(`^${section.id.replace("help-", "")}-`));
    }
  });

  it("文言が空でない（読み上げは alt と番号の説明だけで通じるように）", () => {
    for (const { shot } of shots) {
      expect(shot.alt.length, shot.id).toBeGreaterThan(5);
      expect(shot.caption.length, shot.id).toBeGreaterThan(5);
      expect(shot.hotspots.length, shot.id).toBeGreaterThan(0);
      expect(shot.hotspots.length, shot.id).toBeLessThanOrEqual(5);
      const texts = shot.hotspots.map((h) => h.text);
      expect(new Set(texts).size, shot.id).toBe(texts.length); // 印の文は key に使う
      for (const text of texts) {
        expect(text.length, text).toBeGreaterThan(3);
        expect(text.length, text).toBeLessThanOrEqual(60);
        expect(text, text).not.toMatch(/[①-⑳]/); // 番号は画面が振る
      }
    }
  });

  it("★撮った寸法と印の位置が、文言と1対1で揃っている", () => {
    expect(Object.keys(HELP_SHOT_GEOMETRY).sort()).toEqual(shots.map(({ shot }) => shot.id).sort());
    for (const { shot } of shots) {
      const geometry = HELP_SHOT_GEOMETRY[shot.id];
      expect(geometry, `${shot.id} を撮り直してください`).toBeDefined();
      expect(geometry.hotspots.length, shot.id).toBe(shot.hotspots.length);
      expect(geometry.width, shot.id).toBeGreaterThan(0);
      expect(geometry.height, shot.id).toBeGreaterThan(0);
      for (const at of geometry.hotspots) {
        expect(at.x, shot.id).toBeGreaterThanOrEqual(0);
        expect(at.x, shot.id).toBeLessThanOrEqual(100);
        expect(at.y, shot.id).toBeGreaterThanOrEqual(0);
        expect(at.y, shot.id).toBeLessThanOrEqual(100);
      }
    }
  });

  it("★画像が実在し、重くなりすぎない（1枚200KB・合計1.5MBまで）", () => {
    let total = 0;
    for (const { shot } of shots) {
      const path = `public${helpShotSrc(shot)}`;
      expect(existsSync(path), `${path} がありません（npm run help:shots）`).toBe(true);
      const bytes = statSync(path).size;
      expect(bytes, path).toBeGreaterThan(0);
      expect(bytes, path).toBeLessThanOrEqual(200 * 1024);
      total += bytes;
    }
    expect(total).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  });
});
