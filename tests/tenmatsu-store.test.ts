import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAll,
  deleteMeta,
  hasStoredData,
  META_TENMATSU_LIST,
  saveMeta,
  SETTING_KEY_TENMATSU_MAX_PER_RUN,
  SETTING_KEY_TENMATSU_TOKEN,
} from "@/lib/storage";
import type { ListItem } from "@/lib/tenmatsu/client";
import {
  clearCachedList,
  clearToken,
  hasTenmatsuData,
  loadCachedList,
  loadMaxPerRun,
  loadToken,
  saveCachedList,
  saveMaxPerRun,
  saveToken,
} from "@/lib/tenmatsu/store";

const item = (no: string, over: Partial<ListItem> = {}): ListItem => ({
  denpyo_no: no,
  file: `顛末書No.${no.slice(-4)}.pdf`,
  at: "2026-09-04T10:00:00",
  exists: true,
  pages: 3,
  size: 29140,
  budget_entered: false,
  cloud_stored: false,
  completed: false,
  flags_updated_at: null,
  ...over,
});

/** 完了フラグに未対応だった頃に書かれたキャッシュ (6項目だけ) */
const oldShapeItem = {
  denpyo_no: "TE00009001",
  file: "顛末書No.9001.pdf",
  at: "2026-09-04T10:00:00",
  exists: true,
  pages: 3,
  size: 29140,
};

beforeEach(async () => {
  await clearAll();
  await clearToken();
  await clearCachedList();
  await deleteMeta(SETTING_KEY_TENMATSU_MAX_PER_RUN);
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
  it("clearAll でも顛末書のトークン・一覧・件数は残る", async () => {
    await saveToken("t");
    await saveCachedList([item("TE00009001", { budget_entered: true })]);
    await saveMaxPerRun(30);
    await clearAll();
    expect(await loadToken()).toBe("t");
    expect(await loadCachedList()).toEqual([item("TE00009001", { budget_entered: true })]);
    expect(await loadMaxPerRun()).toBe(30);
  });

  it("顛末書のデータだけでは定期点検の消去ボタンは出ない", async () => {
    await saveToken("t");
    await saveCachedList([item("TE00009001")]);
    expect(await hasStoredData()).toBe(false);
  });
});

describe("完了フラグを含むキャッシュ", () => {
  it("フラグ付きの行を保存して読み直せる", async () => {
    const rows = [
      item("TE00009004", {
        budget_entered: true,
        cloud_stored: true,
        completed: true,
        flags_updated_at: "2026-09-04T18:20:00",
      }),
      item("TE00009001"),
    ];
    await saveCachedList(rows);
    expect(await loadCachedList()).toEqual(rows);
  });

  it("フラグを持たない古いキャッシュも捨てない", async () => {
    // 捨てると、記録が693件あるのに「まだ取得した顛末書はありません」と出てしまう。
    // フラグを false で埋めるのも駄目 (入力し終えた伝票が未入力に見える) ので、
    // 「分からない」まま残して画面で「－」と出す
    await saveMeta(META_TENMATSU_LIST, [oldShapeItem]);
    const loaded = await loadCachedList();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].budget_entered).toBeUndefined();
    expect(loaded[0].completed).toBeUndefined();
  });

  it("フラグの型が違う行は捨てる", async () => {
    await saveMeta(META_TENMATSU_LIST, [{ ...oldShapeItem, budget_entered: 1 }]);
    expect(await loadCachedList()).toEqual([]);
  });
});

describe("1回に取る件数", () => {
  it("保存して読み直せる", async () => {
    await saveMaxPerRun(30);
    expect(await loadMaxPerRun()).toBe(30);
  });

  it("未保存なら null", async () => {
    expect(await loadMaxPerRun()).toBeNull();
  });

  it("整数でない値は null で返す (サーバーの既定値を使わせる)", async () => {
    for (const raw of ["30", 10.5, Number.NaN, null, {}]) {
      await saveMeta(SETTING_KEY_TENMATSU_MAX_PER_RUN, raw);
      expect(await loadMaxPerRun()).toBeNull();
    }
  });

  it("範囲外でもそのまま保存する (丸めるのは使うとき)", async () => {
    await saveMaxPerRun(150);
    expect(await loadMaxPerRun()).toBe(150);
  });

  it("一覧やトークンを消しても残る", async () => {
    await saveMaxPerRun(30);
    await saveToken("t");
    await saveCachedList([item("TE00009001")]);
    await clearCachedList();
    await clearToken();
    expect(await loadMaxPerRun()).toBe(30);
  });

  it("件数だけでは保存データありと見なさない", async () => {
    await saveMaxPerRun(30);
    expect(await hasTenmatsuData()).toBe(false);
  });
});
