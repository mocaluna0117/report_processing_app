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
import { clearAll, hasStoredData } from "@/lib/storage";

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
  // 書体の登録は clearAll では残るので、テスト間の持ち越しを防ぐため設定ごと消す
  await clearAll({ includeSettings: true });
});

describe.skipIf(!regular || !bold)("端末のフォント登録", () => {
  it("既定では未登録 (同梱の書体を使う)", async () => {
    expect(await loadLocalFontInfo()).toBeNull();
    expect(await loadLocalFonts()).toBeNull();
  });

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

describe.skipIf(!regular)("書体の登録は保存データの消去で消えない", () => {
  it("clearAll では残り、includeSettings を指定したときだけ消える", async () => {
    await registerFromFiles([toFile(regular!, "regular.ttf")]);
    // 顧客データの消去 (「保存データを消去」ボタン) では残す
    await clearAll();
    expect(await loadLocalFontInfo()).not.toBeNull();
    expect(await loadLocalFonts()).not.toBeNull();
    // 設定ごと消す指定のときだけ消える
    await clearAll({ includeSettings: true });
    expect(await loadLocalFontInfo()).toBeNull();
  }, 30_000);

  it("書体を登録しただけでは「保存データあり」と数えない", async () => {
    await registerFromFiles([toFile(regular!, "regular.ttf")]);
    expect(await hasStoredData()).toBe(false);
  }, 30_000);
});

describe.skipIf(!regular)("登録が途中で失敗したとき", () => {
  it("中途半端な記録を残さない (容量だけ使う状態を作らない)", async () => {
    const { saveMeta, loadMeta, SETTING_KEY_FONT_REGULAR } = await import("@/lib/storage");
    // 2つ目の保存で失敗する状況を作る
    const original = IDBObjectStore.prototype.put;
    let calls = 0;
    IDBObjectStore.prototype.put = function put(this: IDBObjectStore, ...args: unknown[]) {
      calls += 1;
      if (calls === 2) throw new DOMException("quota", "QuotaExceededError");
      return (original as (...a: unknown[]) => IDBRequest).apply(this, args);
    } as typeof IDBObjectStore.prototype.put;
    try {
      await expect(registerFromFiles([toFile(regular!, "regular.ttf")])).rejects.toThrow();
    } finally {
      IDBObjectStore.prototype.put = original;
    }
    // 画面上は未登録なのにフォント本体だけ残る、という状態になっていないこと
    expect(await loadLocalFontInfo()).toBeNull();
    expect(await loadMeta(SETTING_KEY_FONT_REGULAR)).toBeUndefined();
    void saveMeta;
  }, 30_000);
});
