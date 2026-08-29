// 実行時に必要な静的ファイルを public/ へコピーする (postinstall)。
// - pdfjs の worker: new URL(..., import.meta.url) による解決はバンドラ依存で壊れやすいため
//   固定パス /pdf.worker.min.mjs で配信し GlobalWorkerOptions.workerSrc に指定する
// - HarfBuzz の hb-subset (WebAssembly): 完了報告書PDFのフォントを必要な文字だけに絞るのに使う
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** パッケージ内のファイルは exports で公開されていないことがあるので、入口のパスから辿る */
function resolveInPackage(pkg, file) {
  return join(dirname(require.resolve(pkg)), file);
}

const copies = [
  [join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"), join(root, "public/pdf.worker.min.mjs")],
  [resolveInPackage("harfbuzzjs", "harfbuzz-subset.wasm"), join(root, "public/report/harfbuzz-subset.wasm")],
];

for (const [src, dest] of copies) {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  console.log(`copied ${dest.slice(root.length + 1)}`);
}
