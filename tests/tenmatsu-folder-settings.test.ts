import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteMeta, loadMeta, saveMeta } from "@/lib/storage";
import { FOLDER_ATTACHMENTS, LOCAL_SERVER_ATTACHMENTS } from "@/lib/tenmatsu/pending";
import { UPLOADABLE_EXTS } from "@/lib/tenmatsu/local/merge";
import {
  forgetLogin,
  getFolderSession,
  getSessionToken,
  keepFolderSession,
  resetFolderSessions,
  setLogin,
  subscribeLogin,
} from "@/lib/tenmatsu/local/session";
import { idbStatsCache } from "@/lib/tenmatsu/local/stats-cache";
import {
  clearFolderHandle,
  clearFolderList,
  clearLegacyRakurakuUserId,
  clearRakurakuCredential,
  defaultSource,
  hasFolderData,
  loadDept,
  loadFolderHandle,
  loadFolderList,
  loadPdfStats,
  loadRoutePin,
  loadRakurakuCredential,
  loadSource,
  saveDept,
  saveFolderHandle,
  saveFolderList,
  saveRoutePin,
  saveRakurakuCredential,
  saveSource,
} from "@/lib/tenmatsu/store";

const KEYS = [
  "tenmatsu:source",
  "senketsu:source",
  "tenmatsu:folder",
  "tenmatsu:folderList",
  "tenmatsu:dept",
  "senketsu:dept",
  "tenmatsu:pdfStats",
  "tenmatsu:route",
  "senketsu:route",
  "rakuraku:userId",
  "rakuraku:credential:kasou-taro",
  "rakuraku:credential:kasou-hanako",
  "tenmatsu:list",
];

beforeEach(async () => {
  for (const key of KEYS) await deleteMeta(key);
  resetFolderSessions();
});

describe("取得の方法", () => {
  it("保存していなければ null。種類ごとに別に覚える", async () => {
    expect(await loadSource("tenmatsu")).toBeNull();
    await saveSource("tenmatsu", "folder");
    await saveSource("senketsu", "local-server");
    expect(await loadSource("tenmatsu")).toBe("folder");
    expect(await loadSource("senketsu")).toBe("local-server");
  });

  it("★保存していないとき: 旧方式のトークンを登録済みなら今までの方式、そうでなければ新しい方式", () => {
    expect(defaultSource(true)).toBe("local-server");
    expect(defaultSource(false)).toBe("folder");
  });
});

describe("新しい方式の設定", () => {
  it("保存先フォルダーの場所（フォルダーでない値は読まない）", async () => {
    expect(await loadFolderHandle("tenmatsu")).toBeNull();
    await saveFolderHandle("tenmatsu", { kind: "directory", name: "顛末書" });
    expect(await loadFolderHandle("tenmatsu")).toEqual({ kind: "directory", name: "顛末書" });
    await saveFolderHandle("tenmatsu", { kind: "file", name: "x" });
    expect(await loadFolderHandle("tenmatsu")).toBeNull();
    await clearFolderHandle("tenmatsu");
    expect(await loadFolderHandle("tenmatsu")).toBeNull();
  });

  it("★新しい方式の一覧は、旧方式の一覧とは別の場所に置く", async () => {
    const item = { denpyo_no: "TE00009101", file: "顛末書№9101.pdf", at: null, exists: true, pages: 1, size: 10 };
    await saveFolderList("tenmatsu", [item]);
    expect(await loadFolderList("tenmatsu")).toEqual([item]);
    expect(await loadMeta("tenmatsu:list")).toBeUndefined();
    await clearFolderList("tenmatsu");
    expect(await loadFolderList("tenmatsu")).toEqual([]);
  });

  it("部門は種類ごとに覚える。形が合わなければ null", async () => {
    await saveDept("tenmatsu", { code: "1800", label: "アフターメンテナンス課(1800)" });
    expect(await loadDept("tenmatsu")).toEqual({ code: "1800", label: "アフターメンテナンス課(1800)" });
    expect(await loadDept("senketsu")).toBeNull();
  });

  it("★楽楽精算の登録は、暗号の控えだけを Folio のアカウントごとに置く（平文のIDとパスワードの入れ物は無い）", async () => {
    const stored = { sealed: "c1.kasou.sealed.value", ver: "ver-1", idHint: "••••01", savedAt: 1_800_000_000_000 };
    await saveRakurakuCredential("kasou-taro", { ...stored, password: "架空" } as never);
    // ★余計な欄（パスワードなど）は書かない
    expect(await loadMeta("rakuraku:credential:kasou-taro")).toEqual(stored);
    expect(await loadRakurakuCredential("kasou-taro")).toEqual(stored);
    // ほかの人の Folio のアカウントでは見えない
    expect(await loadRakurakuCredential("kasou-hanako")).toBeNull();
    // 形が合わないものは無いものとして扱う
    await saveMeta("rakuraku:credential:kasou-hanako", { sealed: "", ver: 1 });
    expect(await loadRakurakuCredential("kasou-hanako")).toBeNull();
    await clearRakurakuCredential("kasou-taro");
    expect(await loadRakurakuCredential("kasou-taro")).toBeNull();
  });

  it("前の方式で覚えていたログインID（平文）は消せる", async () => {
    await saveMeta("rakuraku:userId", "99-test");
    await clearLegacyRakurakuUserId();
    expect(await loadMeta("rakuraku:userId")).toBeUndefined();
  });
});

describe("一覧の経路の固定（このブラウザに置く）", () => {
  it("固定した経路が次に読める。自動（null）に戻せる", async () => {
    expect(await loadRoutePin("tenmatsu")).toBeNull();
    await saveRoutePin("tenmatsu", "shinsei");
    expect(await loadRoutePin("tenmatsu")).toBe("shinsei");
    // 種類ごとに別
    expect(await loadRoutePin("senketsu")).toBeNull();
    await saveRoutePin("tenmatsu", null);
    expect(await loadRoutePin("tenmatsu")).toBeNull();
  });

  it("★知らない値が入っていても、その経路を固定したことにしない", async () => {
    await saveMeta("tenmatsu:route", "keihi");
    expect(await loadRoutePin("tenmatsu")).toBeNull();
    await deleteMeta("tenmatsu:route");
  });
});

describe("★ログイン状態はこのタブにだけ置く", () => {
  it("覚えて、忘れる。変わったら知らせる", () => {
    const seen: string[] = [];
    const stop = subscribeLogin(() => seen.push(`${getSessionToken()}`));
    setLogin({ sessionToken: "sealed" });
    setLogin({ sessionToken: "refreshed" });
    getFolderSession("tenmatsu").departments = [{ code: "1800", label: "アフター(1800)" }];
    forgetLogin();
    stop();
    expect(seen).toEqual(["sealed", "refreshed", "null"]);
    // ログインを忘れたら、読んだ部門も読み直させる
    expect(getFolderSession("tenmatsu").departments).toBeNull();
  });

  it("種類ごとの控えは別々で、控えた内容が別の種類へ漏れない", () => {
    const { hydrated: _h, ...rest } = getFolderSession("tenmatsu");
    keepFolderSession("tenmatsu", { ...rest, maxInput: "5", deptCode: "1800" });
    expect(getFolderSession("tenmatsu")).toMatchObject({ hydrated: true, maxInput: "5", deptCode: "1800" });
    expect(getFolderSession("senketsu")).toMatchObject({ hydrated: false, maxInput: "", deptCode: null });
  });
});

describe("PDF のページ数の控え（このブラウザに置く）", () => {
  it("書いた値が次に読める。少し遅れてまとめて保存する", async () => {
    const cache = idbStatsCache("tenmatsu", { flushDelayMs: 5 });
    expect(await cache.get("a.pdf|10|1")).toBeUndefined();
    await cache.set("a.pdf|10|1", 3);
    await cache.set("b.pdf|10|1", null);
    expect(await cache.get("a.pdf|10|1")).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await loadPdfStats("tenmatsu")).toEqual({ "a.pdf|10|1": 3, "b.pdf|10|1": null });
    // 読み直した控えからも読める
    expect(await idbStatsCache("tenmatsu").get("b.pdf|10|1")).toBeNull();
  });
});

describe("保留に入れられる形式（取得の方法ごと）", () => {
  it("★新しい方式は、結合できる形式（PDF と画像）だけを選ばせる。結合する側の決まりと一致させる", () => {
    expect(new Set(FOLDER_ATTACHMENTS.extensions.map((e) => `.${e}`))).toEqual(UPLOADABLE_EXTS);
    expect(FOLDER_ATTACHMENTS.pattern.test("見積.PDF")).toBe(true);
    expect(FOLDER_ATTACHMENTS.pattern.test("写真.jpeg")).toBe(true);
    expect(FOLDER_ATTACHMENTS.pattern.test("見積.xlsx")).toBe(false);
    expect(FOLDER_ATTACHMENTS.accept).toBe(".pdf,.jpg,.jpeg,.png");
    expect(FOLDER_ATTACHMENTS.convertNote).toBeNull();
  });

  it("今までの方式は Office も選べる（変わっていない）", () => {
    expect(LOCAL_SERVER_ATTACHMENTS.pattern.test("見積.xlsx")).toBe(true);
    expect(LOCAL_SERVER_ATTACHMENTS.accept).toContain(".msg");
    expect(LOCAL_SERVER_ATTACHMENTS.convertNote).toContain("PCでPDFに変換");
  });
});
