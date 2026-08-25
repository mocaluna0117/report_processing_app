// pdfjs-dist の worker を public/ へコピーする (postinstall)。
// new URL(..., import.meta.url) による worker 解決はバンドラ依存で壊れやすいため、
// 固定パス /pdf.worker.min.mjs で配信し GlobalWorkerOptions.workerSrc に指定する。
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
const dest = join(root, "public/pdf.worker.min.mjs");

await mkdir(dirname(dest), { recursive: true });
await copyFile(src, dest);
console.log(`copied pdf.worker.min.mjs -> public/`);
