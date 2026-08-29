import "fake-indexeddb/auto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearLocalFonts,
  listFaces,
  loadLocalFontInfo,
  loadLocalFonts,
  registerFromFiles,
} from "@/lib/report/fonts";
import { clearAll } from "@/lib/storage";

const FONT_DIR = join(process.cwd(), "public", "report", "fonts");
const load = (prefix: string) => {
  if (!existsSync(FONT_DIR)) return null;
  const file = readdirSync(FONT_DIR).find((f) => f.startsWith(prefix));
  return file ? gunzipSync(new Uint8Array(readFileSync(join(FONT_DIR, file)))) : null;
};
const regular = load("NotoSansJP-Regular");
const bold = load("NotoSansJP-Bold");
const toFile = (bytes: Uint8Array, name: string) =>
  new File([bytes as unknown as BlobPart], name, { type: "font/ttf" });

beforeEach(async () => {
  await clearAll();
});

describe.skipIf(!regular || !bold)("端末のフォント登録", () => {
  it("書体の一覧を読める", async () => {
    const faces = await listFaces(regular!);
    expect(faces).toHaveLength(1);
    expect(faces[0].postscriptName).toContain("NotoSansJP");
    expect(faces[0].weight).toBe(400);
    expect(faces[0].isUiVariant).toBe(false);
  });

  it("2ファイルを登録すると、細い方が通常・太い方が太字になる", async () => {
    // わざと太字を先に渡しても正しく割り当てられること
    const info = await registerFromFiles([toFile(bold!, "bold.ttf"), toFile(regular!, "regular.ttf")]);
    expect(info.regularName).toContain("Regular");
    expect(info.boldName).toContain("Bold");
    expect(info.bytes).toBe(regular!.byteLength + bold!.byteLength);

    const stored = await loadLocalFonts();
    expect(stored?.regular.byteLength).toBe(regular!.byteLength);
    expect(stored?.bold.byteLength).toBe(bold!.byteLength);
    expect(stored?.regularFaceIndex).toBe(0);
  }, 30_000);

  it("1ファイルだけでも登録でき、通常・太字の両方に使う", async () => {
    const info = await registerFromFiles([toFile(regular!, "regular.ttf")]);
    expect(info.regularName).toBe(info.boldName);
  }, 30_000);

  it("解除すると未登録に戻る", async () => {
    await registerFromFiles([toFile(regular!, "regular.ttf")]);
    expect(await loadLocalFontInfo()).not.toBeNull();
    await clearLocalFonts();
    expect(await loadLocalFontInfo()).toBeNull();
    expect(await loadLocalFonts()).toBeNull();
  }, 30_000);

  it("フォントを渡さなければエラー", async () => {
    await expect(registerFromFiles([])).rejects.toThrow();
  });
});
