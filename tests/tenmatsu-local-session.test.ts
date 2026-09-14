import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOGIN_STORAGE_KEY,
  forgetLogin,
  getPassword,
  getSessionToken,
  rememberDepartments,
  resetFolderSessions,
  restoreLogin,
  restoredDepartments,
  setLogin,
} from "@/lib/tenmatsu/local/session";

/** sessionStorage の作り物 (node には window が無いので、テストの間だけ置く) */
class FakeStorage {
  map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

const globals = globalThis as unknown as { window?: { sessionStorage: FakeStorage } };
let storage: FakeStorage;

/** 再読み込み相当 (メモリだけ消え、タブの控えは残る) */
const reload = () => resetFolderSessions();

const DEPTS = [
  { code: "1900", label: "品質管理部(1900)" },
  { code: "1800", label: "アフターメンテナンス課(1800)" },
];

beforeEach(() => {
  storage = new FakeStorage();
  globals.window = { sessionStorage: storage };
  resetFolderSessions();
});

afterEach(() => {
  delete globals.window;
  resetFolderSessions();
});

describe("楽楽精算のログインをタブに残す", () => {
  it("ログインするとタブに控えを書き、再読み込みしても戻る", () => {
    setLogin({ password: "secret-pass", sessionToken: "sealed-1", expiresAt: Date.now() + 60_000 });
    reload();
    expect(getSessionToken()).toBeNull();
    expect(restoreLogin()).toBe(true);
    expect(getSessionToken()).toBe("sealed-1");
  });

  it("★パスワードはタブの控えに入れない (再読み込みすると消える)", () => {
    setLogin({ password: "secret-pass", sessionToken: "sealed-1", expiresAt: Date.now() + 60_000 });
    expect(storage.getItem(LOGIN_STORAGE_KEY)).not.toContain("secret-pass");
    reload();
    restoreLogin();
    expect(getPassword()).toBeNull();
  });

  it("★期限を過ぎた控えは戻さずに消す", () => {
    const now = Date.now();
    setLogin({ sessionToken: "sealed-1", expiresAt: now + 1000 });
    reload();
    expect(restoreLogin(now + 2000)).toBe(false);
    expect(getSessionToken()).toBeNull();
    expect(storage.getItem(LOGIN_STORAGE_KEY)).toBeNull();
  });

  it("取得の途中で届いた新しいトークンは、期限を引き継いで書き直す", () => {
    const now = Date.now();
    setLogin({ sessionToken: "sealed-1", expiresAt: now + 5000 });
    setLogin({ sessionToken: "sealed-2" });
    reload();
    expect(restoreLogin(now + 4000)).toBe(true);
    expect(getSessionToken()).toBe("sealed-2");
    reload();
    expect(restoreLogin(now + 6000)).toBe(false);
  });

  it("ログアウトすると控えも消える", () => {
    setLogin({ sessionToken: "sealed-1", expiresAt: Date.now() + 60_000 });
    forgetLogin();
    reload();
    expect(restoreLogin()).toBe(false);
  });

  it("ログインが切れた (トークンを消した) ときも控えを消す", () => {
    setLogin({ sessionToken: "sealed-1", expiresAt: Date.now() + 60_000 });
    setLogin({ sessionToken: null });
    expect(storage.getItem(LOGIN_STORAGE_KEY)).toBeNull();
  });

  it("部門の選択肢と選んだ部門も戻る (種類ごと)", () => {
    setLogin({ sessionToken: "sealed-1", expiresAt: Date.now() + 60_000 });
    rememberDepartments("tenmatsu", DEPTS, "1900");
    rememberDepartments("senketsu", [], null);
    reload();
    restoreLogin();
    expect(restoredDepartments("tenmatsu")).toEqual({ departments: DEPTS, deptCode: "1900" });
    expect(restoredDepartments("senketsu")).toEqual({ departments: [], deptCode: null });
    expect(restoredDepartments("natsuin")).toBeNull();
  });

  it("ログインしていないときは部門を覚えない", () => {
    rememberDepartments("tenmatsu", DEPTS, "1900");
    expect(storage.getItem(LOGIN_STORAGE_KEY)).toBeNull();
  });

  it("壊れた控えは戻さずに消す", () => {
    storage.setItem(LOGIN_STORAGE_KEY, "{not json");
    expect(restoreLogin()).toBe(false);
    expect(storage.getItem(LOGIN_STORAGE_KEY)).toBeNull();
  });

  it("sessionStorage が使えなくても落ちない (メモリだけで動く)", () => {
    delete globals.window;
    setLogin({ sessionToken: "sealed-1", expiresAt: Date.now() + 60_000 });
    expect(getSessionToken()).toBe("sealed-1");
    reload();
    expect(restoreLogin()).toBe(false);
  });

  it("期限を教えてもらえなかったトークンは期限を見ずに戻す", () => {
    setLogin({ sessionToken: "sealed-1", expiresAt: null });
    reload();
    expect(restoreLogin()).toBe(true);
  });
});
