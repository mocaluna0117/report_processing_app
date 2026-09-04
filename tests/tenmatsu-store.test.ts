import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAll,
  hasStoredData,
  META_TENMATSU_LIST,
  saveMeta,
  SETTING_KEY_TENMATSU_TOKEN,
} from "@/lib/storage";
import type { ListItem } from "@/lib/tenmatsu/client";
import {
  clearCachedList,
  clearToken,
  hasTenmatsuData,
  loadCachedList,
  loadToken,
  saveCachedList,
  saveToken,
} from "@/lib/tenmatsu/store";

const item = (no: string, over: Partial<ListItem> = {}): ListItem => ({
  denpyo_no: no,
  file: `顛末書No.${no.slice(-4)}.pdf`,
  at: "2026-09-04T10:00:00",
  exists: true,
  pages: 3,
  size: 29140,
  ...over,
});

beforeEach(async () => {
  await clearAll();
  await clearToken();
  await clearCachedList();
});

describe("トークン", () => {
  it("保存して読み直せる", async () => {
    await saveToken("Zm9vYmFy_-abc123");
    expect(await loadToken()).toBe("Zm9vYmFy_-abc123");
  });

  it("登録を消せる", async () => {
    await saveToken("t");
    await clearToken();
    expect(await loadToken()).toBeNull();
  });

  it("未登録・空文字は null で返す", async () => {
    expect(await loadToken()).toBeNull();
    await saveMeta(SETTING_KEY_TENMATSU_TOKEN, "");
    expect(await loadToken()).toBeNull();
  });
});

describe("取得済み一覧のキャッシュ", () => {
  it("保存して読み直せる", async () => {
    const items = [item("TE00009001"), item("TE00009002", { exists: false, pages: null })];
    await saveCachedList(items);
    expect(await loadCachedList()).toEqual(items);
  });

  it("0件はそのまま保存する (サーバー側の正しい状態なので守らない)", async () => {
    await saveCachedList([item("TE00009001")]);
    await saveCachedList([]);
    expect(await loadCachedList()).toEqual([]);
  });

  it("形の合わない記録は捨てる", async () => {
    await saveMeta(META_TENMATSU_LIST, "なにか");
    expect(await loadCachedList()).toEqual([]);
    await saveMeta(META_TENMATSU_LIST, [{ denpyo_no: 1 }, item("TE00009001")]);
    expect(await loadCachedList()).toEqual([item("TE00009001")]);
  });

  it("キャッシュだけ消してもトークンは残る", async () => {
    await saveToken("t");
    await saveCachedList([item("TE00009001")]);
    await clearCachedList();
    expect(await loadCachedList()).toEqual([]);
    expect(await loadToken()).toBe("t");
  });
});

describe("hasTenmatsuData", () => {
  it("トークンだけ・一覧だけでも true、両方消せば false", async () => {
    expect(await hasTenmatsuData()).toBe(false);
    await saveToken("t");
    expect(await hasTenmatsuData()).toBe(true);
    await clearToken();
    await saveCachedList([item("TE00009001")]);
    expect(await hasTenmatsuData()).toBe(true);
    await clearCachedList();
    expect(await hasTenmatsuData()).toBe(false);
  });
});

describe("定期点検の「保存データを消去」との切り分け", () => {
  it("clearAll でも顛末書のトークンと一覧は残る", async () => {
    await saveToken("t");
    await saveCachedList([item("TE00009001")]);
    await clearAll();
    expect(await loadToken()).toBe("t");
    expect(await loadCachedList()).toHaveLength(1);
  });

  it("顛末書のデータだけでは定期点検の消去ボタンは出ない", async () => {
    await saveToken("t");
    await saveCachedList([item("TE00009001")]);
    expect(await hasStoredData()).toBe(false);
  });
});
