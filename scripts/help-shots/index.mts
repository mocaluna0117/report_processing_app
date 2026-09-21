// 「使い方」ページの写真を撮る入口。中身は run.ts（型検査が効くように .ts に置く）
import { main } from "./run";

process.exitCode = await main(process.argv.slice(2));
