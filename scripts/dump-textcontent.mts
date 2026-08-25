// 写真報告書PDFのテキストトークン (文字列+座標) をダンプする開発補助スクリプト。
// テンプレート改版時の座標再計測や期待値フィクスチャ作成に使う。
// 使い方: npm run dump -- "<PDFパス>" [--parse]
import { getTokensFromFile } from "../tests/helpers/pdf-node";
import { parsePhotoReport } from "../lib/pdf/parse-photo-report";

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--"));
if (!path) {
  console.error('usage: npm run dump -- "<PDFパス>" [--parse]');
  process.exit(1);
}

const { tokens, pageCount } = await getTokensFromFile(path);

if (args.includes("--parse")) {
  console.log(JSON.stringify(parsePhotoReport(tokens, pageCount), null, 1));
} else {
  console.log(`pages: ${pageCount}`);
  for (const t of tokens) {
    console.log(
      `p${t.page}\tx=${t.x.toFixed(2)}\ty=${t.y.toFixed(2)}\t${JSON.stringify(t.str)}`,
    );
  }
}
