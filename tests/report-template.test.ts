import { readFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";

/**
 * 同梱テンプレート (public/report/completion-report.xlsx) 自体の検査。
 * scripts/build_report_template.py が作り直したときに、シート構成や
 * 個人情報の除去が崩れていないかをここで止める。
 */
const parts = unzipSync(new Uint8Array(readFileSync(join(process.cwd(), "public", "report", "completion-report.xlsx"))));
const text = (name: string) => new TextDecoder().decode(parts[name]);
const workbook = text("xl/workbook.xml");

describe("同梱テンプレート", () => {
  it("シートは入力シート・本紙・別紙の3つだけ (非表示シートは削除済み)", () => {
    const names = [...workbook.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
    expect(names).toEqual(["入力シート", "作業報告書　兼　完了報告書", "別紙"]);
    expect(workbook).not.toContain('state="hidden"');
  });

  it("削除したシートに紐づくパーツが残っていない", () => {
    for (const name of [
      "xl/worksheets/sheet2.xml",
      "xl/worksheets/sheet5.xml",
      "xl/drawings/drawing1.xml",
      "xl/media/image1.jpg",
      "xl/calcChain.xml",
      "xl/printerSettings/printerSettings4.bin",
    ]) {
      expect(parts[name], name).toBeUndefined();
    }
  });

  it("チェックボックス書式と印刷設定は保たれている", () => {
    expect(parts["xl/featurePropertyBag/featurePropertyBag.xml"]).toBeDefined();
    expect(text("xl/styles.xml")).toContain("xfComplement");
    expect(parts["xl/printerSettings/printerSettings2.bin"]).toBeDefined();
  });

  it("印刷範囲は本紙 (index 1) と別紙 (index 2) に付け替えられている", () => {
    const areas = [...workbook.matchAll(/<definedName name="_xlnm\.Print_Area" localSheetId="(\d+)">([^<]*)</g)];
    expect(areas.map((m) => m[1])).toEqual(["1", "2"]);
    expect(areas[0][2]).toContain("$B$1:$U$33");
    expect(areas[1][2]).toContain("$A$1:$B$29");
  });

  it("参照が全て解決できる (rels の Target と Content_Types の Override)", () => {
    const names = new Set(Object.keys(parts));
    for (const name of names) {
      if (!name.endsWith(".rels")) continue;
      const base = name === "_rels/.rels" ? "" : name.replace(/\/_rels\/[^/]+$/, "");
      for (const [, target] of text(name).matchAll(/Target="([^"]*)"/g)) {
        if (/^(https?:|\/)/.test(target)) continue;
        const segments: string[] = [];
        for (const seg of `${base}/${target}`.split("/")) {
          if (seg === "" || seg === ".") continue;
          if (seg === "..") segments.pop();
          else segments.push(seg);
        }
        expect(names.has(segments.join("/")), `${name} → ${target}`).toBe(true);
      }
    }
    for (const [, part] of text("[Content_Types].xml").matchAll(/<Override PartName="\/([^"]*)"/g)) {
      expect(names.has(part), part).toBe(true);
    }
  });

  it("個人情報が残っていない (作成者・絶対パス・例示データ)", () => {
    // 実名をこのファイルに書かないよう、構造で検査する
    const core = text("docProps/core.xml");
    expect(core).toMatch(/<dc:creator><\/dc:creator>/);
    expect(core).toMatch(/<cp:lastModifiedBy><\/cp:lastModifiedBy>/);
    expect(core).not.toContain("lastPrinted");
    const xmlParts = Object.keys(parts).filter((n) => n.endsWith(".xml") || n.endsWith(".rels"));
    for (const name of xmlParts) {
      const xml = text(name);
      // 作成者の個人フォルダパスと、契約番号のような長い数字列
      expect(xml, `${name} に absPath`).not.toContain("absPath");
      // 属性値 (座標・GUID・余白の小数) ではなく、要素の中身 (セルの文字列) だけを見る
      // 様式に元から入っている自社のTEL/FAXは個人情報ではないので除く
      const content = (xml.match(/>[^<]+</g) ?? [])
        .join(" ")
        .replaceAll("03-6271-6209", "")
        .replaceAll("03-6271-6219", "");
      expect(content.match(/\d{9,}/), `${name} に長い数字列`).toBeNull();
      expect(content.match(/\d{2,4}-\d{2,4}-\d{3,4}/), `${name} に電話番号`).toBeNull();
    }
    // 点検予定履歴出力シートの例示データ (社員名・日付・指摘文・契約番号) は空にしてある
    const shared = text("xl/sharedStrings.xml").match(/<si>[\s\S]*?<\/si>/g) ?? [];
    for (const index of [110, 111, 112, 113, 114]) {
      expect(shared[index], `sharedStrings[${index}]`).toBe("<si><t/></si>");
    }
  });

  it("書き込み先のセルが揃っている", () => {
    const input = text("xl/worksheets/sheet1.xml");
    for (const ref of ["C4", "C5", "C6", "C7", "C8", "C9", "C10", "C12", "C13", "B17", "C17", "B21", "C21"]) {
      expect(input, ref).toContain(`<c r="${ref}"`);
    }
    const main = text("xl/worksheets/sheet3.xml");
    for (const ref of ["D5", "O5", "D6", "D7", "D8", "D9", "O9", "D13", "M13", "B16", "C20", "B27"]) {
      expect(main, ref).toContain(`<c r="${ref}"`);
    }
    for (const ref of ["D11", "G11", "K11", "D12", "G12", "K12", "N12", "Q12", "T23", "T27"]) {
      expect(main, ref).toMatch(new RegExp(`<c r="${ref}"[^>]*t="b"`));
    }
    const appendix = text("xl/worksheets/sheet4.xml");
    for (let k = 0; k < 12; k++) {
      expect(appendix, `A${6 + 2 * k}`).toContain(`<c r="A${6 + 2 * k}"`);
      expect(appendix, `A${7 + 2 * k}`).toContain(`<c r="A${7 + 2 * k}"`);
    }
  });
});

describe("同梱アセットの名前", () => {
  it("asset-names.generated.ts の参照先が実在する", async () => {
    const { existsSync } = await import("node:fs");
    const names = await import("@/lib/report/asset-names.generated");
    for (const url of [
      names.REPORT_TEMPLATE_URL,
      names.REPORT_FONT_REGULAR_URL,
      names.REPORT_FONT_BOLD_URL,
    ]) {
      expect(url.startsWith("/report/"), url).toBe(true);
      expect(existsSync(join(process.cwd(), "public", url)), url).toBe(true);
    }
  });
});
