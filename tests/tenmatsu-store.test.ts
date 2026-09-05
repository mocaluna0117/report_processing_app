import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAll,
  deleteMeta,
  hasStoredData,
  loadMeta,
  META_SENKETSU_LIST,
  META_TENMATSU_LIST,
  saveMeta,
  SETTING_KEY_SENKETSU_MAX_PER_RUN,
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
  await deleteMeta(META_SENKETSU_LIST);
  await deleteMeta(SETTING_KEY_SENKETSU_MAX_PER_RUN);
  await clearToken();
  await clearCachedList("tenmatsu");
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
    await saveCachedList("tenmatsu", items);
    expect(await loadCachedList("tenmatsu")).toEqual(items);
  });

  it("0件はそのまま保存する (サーバー側の正しい状態なので守らない)", async () => {
    await saveCachedList("tenmatsu", [item("TE00009001")]);
    await saveCachedList("tenmatsu", []);
    expect(await loadCachedList("tenmatsu")).toEqual([]);
  });

  it("形の合わない記録は捨てる", async () => {
    await saveMeta(META_TENMATSU_LIST, "なにか");
    expect(await loadCachedList("tenmatsu")).toEqual([]);
    await saveMeta(META_TENMATSU_LIST, [{ denpyo_no: 1 }, item("TE00009001")]);
    expect(await loadCachedList("tenmatsu")).toEqual([item("TE00009001")]);
  });

  it("キャッシュだけ消してもトークンは残る", async () => {
    await saveToken("t");
    await saveCachedList("tenmatsu", [item("TE00009001")]);
    await clearCachedList("tenmatsu");
    expect(await loadCachedList("tenmatsu")).toEqual([]);
    expect(await loadToken()).toBe("t");
  });
});

describe("hasTenmatsuData", () => {
  it("トークンだけ・一覧だけでも true、両方消せば false", async () => {
    expect(await hasTenmatsuData("tenmatsu")).toBe(false);
    await saveToken("t");
    expect(await hasTenmatsuData("tenmatsu")).toBe(true);
    await clearToken();
    await saveCachedList("tenmatsu", [item("TE00009001")]);
    expect(await hasTenmatsuData("tenmatsu")).toBe(true);
    await clearCachedList("tenmatsu");
    expect(await hasTenmatsuData("tenmatsu")).toBe(false);
  });
});

describe("定期点検の「保存データを消去」との切り分け", () => {
  it("clearAll でも顛末書のトークン・一覧・件数は残る", async () => {
    await saveToken("t");
    await saveCachedList("tenmatsu", [item("TE00009001", { budget_entered: true })]);
    await saveMaxPerRun("tenmatsu", 30);
    await clearAll();
    expect(await loadToken()).toBe("t");
    expect(await loadCachedList("tenmatsu")).toEqual([item("TE00009001", { budget_entered: true })]);
    expect(await loadMaxPerRun("tenmatsu")).toBe(30);
  });

  it("顛末書のデータだけでは定期点検の消去ボタンは出ない", async () => {
    await saveToken("t");
    await saveCachedList("tenmatsu", [item("TE00009001")]);
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
    await saveCachedList("tenmatsu", rows);
    expect(await loadCachedList("tenmatsu")).toEqual(rows);
  });

  it("フラグを持たない古いキャッシュも捨てない", async () => {
    // 捨てると、記録が693件あるのに「まだ取得した顛末書はありません」と出てしまう。
    // フラグを false で埋めるのも駄目 (入力し終えた伝票が未入力に見える) ので、
    // 「分からない」まま残して画面で「－」と出す
    await saveMeta(META_TENMATSU_LIST, [oldShapeItem]);
    const loaded = await loadCachedList("tenmatsu");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].budget_entered).toBeUndefined();
    expect(loaded[0].completed).toBeUndefined();
  });

  it("フラグの型が違う行は捨てる", async () => {
    await saveMeta(META_TENMATSU_LIST, [{ ...oldShapeItem, budget_entered: 1 }]);
    expect(await loadCachedList("tenmatsu")).toEqual([]);
  });
});

describe("1回に取る件数", () => {
  it("保存して読み直せる", async () => {
    await saveMaxPerRun("tenmatsu", 30);
    expect(await loadMaxPerRun("tenmatsu")).toBe(30);
  });

  it("未保存なら null", async () => {
    expect(await loadMaxPerRun("tenmatsu")).toBeNull();
  });

  it("整数でない値は null で返す (サーバーの既定値を使わせる)", async () => {
    for (const raw of ["30", 10.5, Number.NaN, null, {}]) {
      await saveMeta(SETTING_KEY_TENMATSU_MAX_PER_RUN, raw);
      expect(await loadMaxPerRun("tenmatsu")).toBeNull();
    }
  });

  it("範囲外でもそのまま保存する (丸めるのは使うとき)", async () => {
    await saveMaxPerRun("tenmatsu", 150);
    expect(await loadMaxPerRun("tenmatsu")).toBe(150);
  });

  it("一覧やトークンを消しても残る", async () => {
    await saveMaxPerRun("tenmatsu", 30);
    await saveToken("t");
    await saveCachedList("tenmatsu", [item("TE00009001")]);
    await clearCachedList("tenmatsu");
    await clearToken();
    expect(await loadMaxPerRun("tenmatsu")).toBe(30);
  });

  it("件数だけでは保存データありと見なさない", async () => {
    await saveMaxPerRun("tenmatsu", 30);
    expect(await hasTenmatsuData("tenmatsu")).toBe(false);
  });
});

describe("種類ごとの保存キー", () => {
  it("★専決決裁書は別のキーに書く", async () => {
    await saveCachedList("senketsu", [item("SE00003001")]);
    expect(await loadMeta(META_SENKETSU_LIST)).toHaveLength(1);
    expect(await loadMeta(META_TENMATSU_LIST)).toBeUndefined();
  });

  it("★片方を消してももう片方は残る", async () => {
    await saveCachedList("tenmatsu", [item("TE00009001")]);
    await saveCachedList("senketsu", [item("SE00003001")]);
    await clearCachedList("senketsu");
    expect(await loadCachedList("tenmatsu")).toHaveLength(1);
    expect(await loadCachedList("senketsu")).toHaveLength(0);
  });

  it("1回に取る件数も種類ごと", async () => {
    await saveMaxPerRun("tenmatsu", 10);
    await saveMaxPerRun("senketsu", 3);
    expect(await loadMaxPerRun("tenmatsu")).toBe(10);
    expect(await loadMaxPerRun("senketsu")).toBe(3);
    expect(await loadMeta(SETTING_KEY_SENKETSU_MAX_PER_RUN)).toBe(3);
  });

  it("★トークンは共有する (同じサーバー・同じトークン)", async () => {
    await saveToken("tok-1");
    expect(await hasTenmatsuData("senketsu")).toBe(true);
    expect(await hasTenmatsuData("tenmatsu")).toBe(true);
  });

  it("定期点検の「保存データを消去」では専決決裁書のキーも消えない", async () => {
    await saveCachedList("senketsu", [item("SE00003001")]);
    await clearAll();
    expect(await loadCachedList("senketsu")).toHaveLength(1);
  });
});
