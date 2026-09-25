import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearTabForAnotherPerson } from "@/lib/account/sign-out";
import {
  LOGIN_STORAGE_KEY,
  ensureSession,
  forgetLogin,
  getLoginProblem,
  getSessionToken,
  getViewTab,
  isLoggingIn,
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
    setLogin({ sessionToken: "sealed-1", expiresAt: Date.now() + 60_000 });
    reload();
    expect(getSessionToken()).toBeNull();
    expect(restoreLogin()).toBe(true);
    expect(getSessionToken()).toBe("sealed-1");
  });

  it("★タブの控えに入るのは封じたログイン状態と期限・部門だけ", () => {
    setLogin({ sessionToken: "sealed-1", expiresAt: Date.now() + 60_000, viewTab: true });
    expect(Object.keys(JSON.parse(storage.getItem(LOGIN_STORAGE_KEY) as string)).sort()).toEqual(
      ["departments", "expiresAt", "sessionToken", "viewTab"].sort(),
    );
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

describe("★登録した控えでのログイン（ensureSession。押したときだけ呼ばれる）", () => {
  const ok = (token = "sealed-1") => async () => ({ sessionToken: token, expiresAt: Date.now() + 60_000, viewTab: false });

  it("ログインしていればそのまま返す（楽楽精算へは行かない）", async () => {
    setLogin({ sessionToken: "sealed-0" });
    let called = 0;
    expect(await ensureSession(async () => {
      called += 1;
      return { sessionToken: "x", expiresAt: null, viewTab: null };
    })).toBe("sealed-0");
    expect(called).toBe(0);
  });

  it("★同時に何か所から呼ばれても、ログインは1回にまとめる。期限・「閲覧」タブも覚える", async () => {
    let called = 0;
    const login = async () => {
      called += 1;
      await new Promise((r) => setTimeout(r, 5));
      return ok()();
    };
    const [a, b] = await Promise.all([ensureSession(login), ensureSession(login)]);
    expect([a, b]).toEqual(["sealed-1", "sealed-1"]);
    expect(called).toBe(1);
    expect(getViewTab()).toBe(false);
    expect(isLoggingIn()).toBe(false);
  });

  it("★失敗したらやり直さずにそのまま返し、画面に出す理由を覚える。成功したら消える", async () => {
    const failure = Object.assign(new Error("前回ログインできませんでした"), { code: "CREDENTIAL_REJECTED" });
    let called = 0;
    await expect(ensureSession(async () => {
      called += 1;
      throw failure;
    })).rejects.toBe(failure);
    expect(called).toBe(1);
    expect(getLoginProblem()).toEqual({ code: "CREDENTIAL_REJECTED", message: "前回ログインできませんでした" });
    expect(getSessionToken()).toBeNull();
    await ensureSession(ok());
    expect(getLoginProblem()).toBeNull();
  });
});

describe("★Folio からログアウトしたとき（次にこの端末を使う人に残さない）", () => {
  it("このタブの楽楽精算のログインを消し、読み込み直しても戻らない", () => {
    setLogin({ sessionToken: "sealed-1", expiresAt: Date.now() + 60_000 });
    clearTabForAnotherPerson();
    expect(getSessionToken()).toBeNull();
    expect(storage.getItem(LOGIN_STORAGE_KEY)).toBeNull();
    reload();
    expect(restoreLogin()).toBe(false);
  });

  it("★ログイン画面で、前の人の控えを戻したあとに呼ばれても消える", () => {
    setLogin({ sessionToken: "sealed-1", expiresAt: Date.now() + 60_000 });
    reload();
    expect(restoreLogin()).toBe(true);
    clearTabForAnotherPerson();
    expect(getSessionToken()).toBeNull();
    expect(storage.getItem(LOGIN_STORAGE_KEY)).toBeNull();
  });
});
