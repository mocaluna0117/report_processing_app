// テスト用: サブセット済み Noto Sans JP を pdf-lib に埋め込み、文字幅を測れるようにする。
// public/report/fonts/ が未生成の環境ではテストを skip できるよう null を返す。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "fflate";

const FONT_DIR = join(process.cwd(), "public", "report", "fonts");

export function reportFontBytes(): { regular: Uint8Array; bold: Uint8Array } | null {
  if (!existsSync(FONT_DIR)) return null;
  const files = readdirSync(FONT_DIR);
  const regular = files.find((f) => f.startsWith("NotoSansJP-Regular") && f.endsWith(".ttf.gz"));
  const bold = files.find((f) => f.startsWith("NotoSansJP-Bold") && f.endsWith(".ttf.gz"));
  if (!regular || !bold) return null;
  return {
    regular: gunzipSync(new Uint8Array(readFileSync(join(FONT_DIR, regular)))),
    bold: gunzipSync(new Uint8Array(readFileSync(join(FONT_DIR, bold)))),
  };
}

/** resolveGeometry に渡す文字幅の計測関数 */
export async function reportMeasure(): Promise<
  ((text: string, size: number, bold: boolean) => number) | null
> {
  const bytes = reportFontBytes();
  if (!bytes) return null;
  const [{ PDFDocument }, fontkit] = await Promise.all([
    import("pdf-lib"),
    import("@pdf-lib/fontkit").then((m) => m.default ?? m),
  ]);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit as never);
  const regular = await doc.embedFont(bytes.regular, { subset: false });
  const bold = await doc.embedFont(bytes.bold, { subset: false });
  return (text, size, isBold) => (isBold ? bold : regular).widthOfTextAtSize(text, size);
}
