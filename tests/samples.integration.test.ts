// 実際の見本PDF5件に対するゴールデンテスト。
// 見本は個人情報を含むためリポジトリ管理外の想定。SAMPLE_PDF_DIR (既定: ./写真報告書_例)
// が存在しない環境ではスキップされる。
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseFileName } from "@/lib/pairing";
import { parsePhotoReport } from "@/lib/pdf/parse-photo-report";
import { getTokensFromFile } from "./helpers/pdf-node";

const sampleDir = process.env.SAMPLE_PDF_DIR ?? join(process.cwd(), "写真報告書_例");
const fixtureDir = join(process.cwd(), "tests/fixtures/expected");
const available = existsSync(sampleDir) && existsSync(fixtureDir);

describe.skipIf(!available)("見本PDFゴールデンテスト", () => {
  const pdfs = available
    ? readdirSync(sampleDir).filter((f) => /\.pdf$/i.test(f))
    : [];

  it("見本が5件ある", () => {
    expect(pdfs).toHaveLength(5);
  });

  for (const fixtureName of available ? readdirSync(fixtureDir) : []) {
    const [date, owner] = fixtureName.replace(/\.json$/, "").split("_");

    it(`${date} ${owner} 邸が期待値と一致する`, async () => {
      const pdf = pdfs.find((f) => f.includes(date) && f.includes(owner));
      expect(pdf, `${date} ${owner} のPDFが見つからない`).toBeDefined();

      const expected = JSON.parse(
        readFileSync(join(fixtureDir, fixtureName), "utf8"),
      );
      const { tokens, pageCount } = await getTokensFromFile(join(sampleDir, pdf!));
      const meta = parseFileName(pdf!);
      const actual = parsePhotoReport(tokens, pageCount, {
        fileNameDate: meta.date ?? undefined,
      });

      expect(actual).toEqual(expected);
    });
  }
});
