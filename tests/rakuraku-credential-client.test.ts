import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FOLIO_LOGOUT_LABEL, FOLIO_LOGOUT_TITLE } from "@/lib/account/menu";
import {
  credentialView,
  deleteCredential,
  loginWithStoredCredential,
  verifyAndSaveCredential,
} from "@/lib/rakuraku-credential";
import { deleteMeta, loadMeta } from "@/lib/storage";
import { type RakurakuApi, RakurakuApiError } from "@/lib/tenmatsu/local/server-api";
import { loadRakurakuCredential, saveRakurakuCredential } from "@/lib/tenmatsu/store";

// 楽楽精算のIDとパスワードの登録（ブラウザ側。2026-09-25）。★値はすべて架空。
const OWNER = "kasou-taro";
const STORED = { sealed: "c1.kasou.sealed.value", ver: "ver-1", idHint: "••••01", savedAt: 1_800_000_000_000 };
const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

beforeEach(async () => {
  await deleteMeta(`rakuraku:credential:${OWNER}`);
});

/** fetch の作り物（呼ばれた中身を残す） */
function fakeFetch(respond: (init: RequestInit | undefined) => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond(init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("画面に出す登録の状態", () => {
  const server = { ver: "ver-1", failures: 0, lastOkAt: null, lastFailAt: null, lastFailReason: null, busy: false };
  it("読み終わるまで・無い・使える・前回失敗・古い", () => {
    expect(credentialView({ loaded: false, stored: null, server: null })).toBe("checking");
    expect(credentialView({ loaded: true, stored: null, server })).toBe("none");
    expect(credentialView({ loaded: true, stored: STORED, server })).toBe("ready");
    expect(credentialView({ loaded: true, stored: STORED, server: { ...server, failures: 1 } })).toBe("rejected");
    expect(credentialView({ loaded: true, stored: STORED, server: { ...server, ver: "ver-2" } })).toBe("stale");
    expect(credentialView({ loaded: true, stored: STORED, server: { ...server, ver: null } })).toBe("stale");
    // サーバーを読めなかったときは「使える」として出す（決めるのはサーバー）
    expect(credentialView({ loaded: true, stored: STORED, server: null })).toBe("ready");
  });
});

describe("確かめて保存・消す", () => {
  it("ログインできたときだけ、暗号の控えをこのブラウザに置く（パスワードは置かない）", async () => {
    const { impl, calls } = fakeFetch(() =>
      Response.json({ ok: true, credential: STORED.sealed, ver: STORED.ver, idHint: STORED.idHint, savedAt: STORED.savedAt, sessionToken: "t", expiresAt: 1, viewTab: true }),
    );
    const result = await verifyAndSaveCredential({ userId: "99-0001", password: "kasou-pass" }, OWNER, impl);
    expect(result).toMatchObject({ ok: true, stored: STORED, session: { sessionToken: "t", expiresAt: 1, viewTab: true } });
    expect(await loadRakurakuCredential(OWNER)).toEqual(STORED);
    expect(JSON.stringify(await loadMeta(`rakuraku:credential:${OWNER}`))).not.toContain("kasou-pass");
    expect(JSON.stringify(await loadMeta(`rakuraku:credential:${OWNER}`))).not.toContain("99-0001");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.credentials).toBe("same-origin");
  });

  it("ログインできなかったときは何も置かず、サーバーの文を返す", async () => {
    const { impl } = fakeFetch(() => Response.json({ ok: false, code: "LOGIN_FAILED", message: "登録はしていません" }));
    expect(await verifyAndSaveCredential({ userId: "99-0001", password: "wrong" }, OWNER, impl)).toEqual({
      ok: false,
      code: "LOGIN_FAILED",
      message: "登録はしていません",
    });
    expect(await loadRakurakuCredential(OWNER)).toBeNull();
  });

  it("Folio のログインが切れていたら、そう言う", async () => {
    const { impl } = fakeFetch(() => new Response("認証が必要です", { status: 401 }));
    const result = await verifyAndSaveCredential({ userId: "99-0001", password: "x" }, OWNER, impl);
    expect(result).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
  });

  it("消すと、サーバーの版を無くし、このブラウザの控えも消える", async () => {
    await saveRakurakuCredential(OWNER, STORED);
    const { impl, calls } = fakeFetch(() => Response.json({ ok: true }));
    expect(await deleteCredential(OWNER, impl)).toEqual({ ok: true });
    expect(calls[0].init?.method).toBe("DELETE");
    expect(await loadRakurakuCredential(OWNER)).toBeNull();
  });

  it("★登録が無ければ、楽楽精算へ送らずに止まる", async () => {
    let called = 0;
    const api = { login: async () => {
      called += 1;
      return { sessionToken: "x", expiresAt: null, viewTab: null };
    } } as unknown as RakurakuApi;
    const error = await loginWithStoredCredential(api, OWNER).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RakurakuApiError);
    expect(error).toMatchObject({ code: "CREDENTIAL_MISSING" });
    expect(called).toBe(0);
    await saveRakurakuCredential(OWNER, STORED);
    const seen: string[] = [];
    const api2 = { login: async (credential: string) => {
      seen.push(credential);
      return { sessionToken: "x", expiresAt: null, viewTab: null };
    } } as unknown as RakurakuApi;
    await loginWithStoredCredential(api2, OWNER);
    expect(seen).toEqual([STORED.sealed]);
  });
});

describe("Folio 自体のログアウト", () => {
  it("名前と、楽楽精算のログインも一緒に忘れること・登録は残ることを書く", () => {
    expect(FOLIO_LOGOUT_LABEL).toBe("Folio からログアウト");
    expect(FOLIO_LOGOUT_TITLE).toContain("このタブの楽楽精算のログインも一緒に忘れます");
    expect(FOLIO_LOGOUT_TITLE).toContain("このPCに残ります");
  });
});

describe("★Folio からログアウトしたら・ログイン画面に来たら、このタブの楽楽精算のログインを消す（中身を読んで見張る）", () => {
  it("ログアウトのフォームを送る前に消す（右上の人の形のアイコンのメニュー）", () => {
    const menu = read("components/account-menu.tsx");
    const form = menu.slice(menu.indexOf('action="/api/logout"'));
    expect(form.slice(0, form.indexOf("</form>"))).toContain("clearTabForAnotherPerson()");
  });

  it("★ログイン画面に移ってきたとき（読み込み直さない移動も）も消す。pathname を見る", () => {
    expect(read("components/mode-nav.tsx")).toMatch(/if \(pathname === "\/login"\) clearTabForAnotherPerson\(\);\s*\}, \[pathname\]\);/);
  });

  it("消すのは、このタブの楽楽精算のログインと問い合わせの下書き（このPCの登録は消さない）", () => {
    const signOut = code("lib/account/sign-out.ts");
    expect(signOut).toContain("forgetLogin();");
    expect(signOut).toContain("clearContactDraft();");
    expect(signOut).not.toMatch(/clearRakurakuCredential|deleteCredential/);
  });
});

describe("★ログインを勝手に呼ばない（画面のテスト基盤が無いので、中身を読んで見張る）", () => {
  const effects = (source: string) =>
    source
      .split("useEffect(")
      .slice(1)
      .map((block) => block.slice(0, block.indexOf("}, [")));

  it("文書の画面は、画面を開いたとき（useEffect）にログインしない", () => {
    const page = code("components/tenmatsu/tenmatsu-folder-page.tsx");
    for (const body of effects(page)) {
      expect(body).not.toMatch(/loginNow\(|loginAndLoadDepartments\(|ensureSession\(|loginWithStoredCredential\(/);
    }
    // ログインを呼ぶのは、押したときの処理（取得・部門を読み込む）と、取得の中（job.ts）だけ
    expect(page).toContain("login: loginNow");
    expect(page).toContain("onClick={() => void loginAndLoadDepartments()}");
  });

  it("アカウントの画面の欄も、開いたときには確かめない（押したときだけ）", () => {
    const form = code("components/account/rakuraku-credential.tsx");
    for (const body of effects(form)) expect(body).not.toContain("verifyAndSaveCredential");
    expect(form).not.toMatch(/<form\b/);
    expect(form).not.toMatch(/localStorage|sessionStorage/);
  });

  it("やり直しの仕掛け（タイマー）を持たない", () => {
    for (const p of ["lib/rakuraku-credential.ts", "components/account/rakuraku-credential.tsx", "components/tenmatsu/rakuraku-line.tsx"]) {
      expect(code(p), p).not.toMatch(/setTimeout|setInterval/);
    }
  });

  it("ヘッダーには楽楽精算の表示もログインの小窓も無い", () => {
    const nav = code("components/mode-nav.tsx");
    expect(nav).not.toMatch(/RakurakuLoginDialog|rakurakuChip|楽楽精算:|\.login\(/);
  });
});
