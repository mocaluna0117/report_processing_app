import { describe, expect, it, vi } from "vitest";
import { handleAccountsRequest, planAdminAction } from "@/lib/account/admin";
import { formatBootstrap, parseBootstrap } from "@/lib/account/bootstrap";
import { handleChangePassword } from "@/lib/account/change-password";
import { handleRename } from "@/lib/account/rename";
import type { AuthConfig } from "@/lib/account/config";
import { requireSignedIn } from "@/lib/account/current";
import { type GateInput, decideAccess } from "@/lib/account/gate";
import { StoreUnavailableError, createMemoryKv } from "@/lib/account/kv";
import { handleLogin } from "@/lib/account/login";
import { canonicalTemp, hashPassword } from "@/lib/account/password";
import { createKeyedLimiter } from "@/lib/account/rate-limit";
import type { AccountRecord } from "@/lib/account/record";
import { OUTAGE_GRACE_SEC, RECHECK_SEC, type SessionState } from "@/lib/account/session";
import { type AccountStore, createAccountStore } from "@/lib/account/store";
import { type SessionClaims, signSession, verifySession } from "@/lib/account/token";
import { createSessionToken, readSignedInMarker } from "@/lib/auth";

// 人ごとのアカウントの流れ（2026-09-24）。★値はすべて架空（公開リポジトリ）。
const FAST = { log2N: 10, r: 8, p: 1 };
const SECRET = "kasou-secret-kasou-secret-kasou-secret-0123";
const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const SAME = { url: "https://folio.invalid/api/x", fetchSite: "same-origin", origin: "https://folio.invalid" };
const CROSS = { url: "https://folio.invalid/api/x", fetchSite: "cross-site", origin: "https://evil.invalid" };

const config = (over: Partial<Extract<AuthConfig, { kind: "accounts" }>> = {}): Extract<AuthConfig, { kind: "accounts" }> => ({
  kind: "accounts",
  store: { kind: "file", path: "/dev/null" },
  secret: SECRET,
  legacy: null,
  bootstrap: null,
  ...over,
});

async function member(over: Partial<AccountRecord> = {}): Promise<AccountRecord> {
  return {
    v: 1,
    id: "kasou-taro",
    name: "架空 太郎",
    role: "member",
    hash: await hashPassword("sakura-tanbo", FAST),
    mustChange: false,
    tempExpiresAt: null,
    disabled: false,
    sv: NOW_MS - 1000,
    createdAt: NOW_MS - 1000,
    passwordChangedAt: null,
    ...over,
  };
}

function setup() {
  const store = createAccountStore(createMemoryKv(() => NOW_MS));
  const limiter = createKeyedLimiter({ windowMs: 60_000, max: 20 });
  return { store, limiter, deps: { store, limiter, scrypt: FAST } };
}

const login = (deps: Parameters<typeof handleLogin>[1], form: { id: string; password: string; next?: string }, over: Partial<Parameters<typeof handleLogin>[0]> = {}) =>
  handleLogin(
    { config: config(), origin: SAME, form: { next: "/", ...form }, ip: "192.0.2.1", secure: true, nowMs: NOW_MS, ...over },
    deps,
  );

const claimsFrom = (cookies: { name: string; value: string }[]) => {
  const token = cookies.find((c) => c.name === "folio_session")?.value;
  return verifySession(token, SECRET, NOW);
};

// ---------------------------------------------------------------------------
describe("門番", () => {
  const claims: SessionClaims = { u: "kasou-taro", sv: NOW_MS - 1000, mc: 0, chk: NOW, exp: NOW + 86_400 };
  const input = (over: Partial<GateInput> = {}): GateInput => ({
    config: config(),
    pathname: "/after",
    search: "",
    session: { kind: "account", claims },
    nowSec: NOW,
    ...over,
  });
  const lookupOf = (found: AccountRecord | null | "unavailable") => vi.fn(async () => found);

  it("アカウントを使わない手元では通す。★設定が足りなければ全部 503", async () => {
    expect(await decideAccess(input({ config: { kind: "off" } }), lookupOf(null))).toEqual({ kind: "pass" });
    const broken = await decideAccess(input({ config: { kind: "broken", missing: [] }, pathname: "/login" }), lookupOf(null));
    expect(broken).toMatchObject({ kind: "text", status: 503 });
  });

  it("ログインの口は通す。旧合言葉のクッキーは通す", async () => {
    const none: SessionState = { kind: "none", hadToken: false };
    for (const pathname of ["/login", "/api/login", "/api/logout"]) {
      expect(await decideAccess(input({ pathname, session: none }), lookupOf(null))).toEqual({ kind: "pass" });
    }
    expect(await decideAccess(input({ session: { kind: "legacy" } }), lookupOf(null))).toEqual({ kind: "pass" });
  });

  it("印が無ければ、API は 401（文字）、ページはログインへ（戻り先つき）", async () => {
    const none: SessionState = { kind: "none", hadToken: false };
    expect(await decideAccess(input({ pathname: "/api/summarize", session: none }), lookupOf(null))).toEqual({
      kind: "text",
      status: 401,
      body: "認証が必要です",
      clear: false,
    });
    expect(await decideAccess(input({ search: "?x=1", session: none }), lookupOf(null))).toEqual({
      kind: "redirect",
      location: "/login?next=%2Fafter%3Fx%3D1",
      clear: false,
    });
  });

  it("壊れた・期限切れの印なら、消してからログインへ（切れたと出す）", async () => {
    const decision = await decideAccess(input({ session: { kind: "none", hadToken: true } }), lookupOf(null));
    expect(decision).toEqual({ kind: "redirect", location: "/login?next=%2Fafter&expired=1", clear: true });
  });

  it("確かめてから5分たっていなければ、Redis を読まない", async () => {
    const lookup = lookupOf(null);
    expect(await decideAccess(input({ nowSec: NOW + RECHECK_SEC - 1 }), lookup)).toEqual({ kind: "pass" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("5分たったら確かめ直し、問題が無ければ印を出し直す", async () => {
    const record = await member();
    const decision = await decideAccess(input({ nowSec: NOW + RECHECK_SEC }), lookupOf(record));
    expect(decision).toEqual({ kind: "pass", reissue: record });
  });

  it("★止めた・パスワードを変えた（版が違う）・消したアカウントは、ログインへ戻す", async () => {
    const later = NOW + RECHECK_SEC;
    for (const found of [await member({ disabled: true }), await member({ sv: NOW_MS }), null]) {
      expect(await decideAccess(input({ nowSec: later }), lookupOf(found))).toMatchObject({ kind: "redirect", clear: true });
    }
  });

  it("Redis が落ちていても12時間までは通す。それを過ぎたら 503", async () => {
    expect(await decideAccess(input({ nowSec: NOW + OUTAGE_GRACE_SEC - 1 }), lookupOf("unavailable"))).toEqual({ kind: "pass" });
    expect(await decideAccess(input({ nowSec: NOW + OUTAGE_GRACE_SEC }), lookupOf("unavailable"))).toMatchObject({
      kind: "text",
      status: 503,
    });
  });

  it("★どのリクエストでも確かめ直す（送る側が書き換えられるヘッダーで省かない）", async () => {
    const lookup = lookupOf(await member({ disabled: true }));
    const decision = await decideAccess(input({ pathname: "/help/after-shared.webp", nowSec: NOW + 3600 }), lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({ kind: "redirect", clear: true });
  });

  it("★仮のパスワードの人は、パスワードを決める画面と送信先・ログアウトだけ", async () => {
    const session: SessionState = { kind: "account", claims: { ...claims, mc: 1 } };
    expect(await decideAccess(input({ session }), lookupOf(null))).toEqual({ kind: "redirect", location: "/account", clear: false });
    expect(await decideAccess(input({ session, pathname: "/api/summarize" }), lookupOf(null))).toMatchObject({ status: 401 });
    for (const pathname of ["/account", "/api/account/password", "/api/logout"]) {
      expect(await decideAccess(input({ session, pathname }), lookupOf(null))).toEqual({ kind: "pass" });
    }
  });
});

// ---------------------------------------------------------------------------
describe("ログイン", () => {
  it("正しければ、戻り先へ。印と表示の印を出す", async () => {
    const { store, deps } = setup();
    await store.create(await member());
    const result = await login(deps, { id: " Kasou-Taro ", password: "sakura-tanbo", next: "/after" });
    expect(result.location).toBe("/after");
    expect(claimsFrom(result.cookies)).toMatchObject({ u: "kasou-taro", mc: 0 });
    const session = result.cookies.find((c) => c.name === "folio_session");
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
    const marker = readSignedInMarker(result.cookies.find((c) => c.name === "folio_signed_in")?.value);
    expect(marker).toMatchObject({ id: "kasou-taro", name: "架空 太郎", admin: false });
  });

  it("★別のサイトから送られたログインは断る", async () => {
    const { store, deps } = setup();
    await store.create(await member());
    const result = await login(deps, { id: "kasou-taro", password: "sakura-tanbo" }, { origin: CROSS });
    expect(result).toEqual({ location: "/login?error=origin", cookies: [] });
  });

  it("★違ったとき、ID が無いときは同じ文（ID の有無を言い分けない）。戻り先は外へ飛ばさない", async () => {
    const { store, deps } = setup();
    await store.create(await member());
    const wrong = await login(deps, { id: "kasou-taro", password: "sakura-tanb0", next: "/\\evil.com" });
    const unknown = await login(deps, { id: "kasou-nobody", password: "sakura-tanbo" });
    expect(wrong.location).toBe("/login?error=1");
    expect(unknown.location).toBe("/login?error=1");
  });

  it("★同じ ID で5回違えたら、正しいパスワードでも15分入れない", async () => {
    const { store, deps } = setup();
    await store.create(await member());
    for (let i = 0; i < 4; i += 1) await login(deps, { id: "kasou-taro", password: "wrong-password" });
    // 4回までは、正しければ入れる（そして数え直し）
    expect((await login(deps, { id: "kasou-taro", password: "sakura-tanbo", next: "/after" })).location).toBe("/after");
    for (let i = 0; i < 5; i += 1) await login(deps, { id: "kasou-taro", password: "wrong-password" });
    const locked = await login(deps, { id: "kasou-taro", password: "sakura-tanbo" });
    expect(locked).toEqual({ location: "/login?error=locked", cookies: [] });
  });

  it("★場所（IP）の回数は失敗だけ数える（同じ事務所の人がログインしても積もらない）", async () => {
    const { store, deps } = setup();
    await store.create(await member());
    for (let i = 0; i < 40; i += 1) {
      // メモリの回数制限（1分に20回）に掛からないよう、1分ずつ空ける（見たいのは Redis の IP の回数）
      const result = await login(deps, { id: "kasou-taro", password: "sakura-tanbo", next: "/after" }, { nowMs: NOW_MS + i * 61_000 });
      expect(result.location).toBe("/after");
    }
  });

  it("★同時に20回送られても、照合するのは5回まで（照合の前に数える）", async () => {
    const { store, deps } = setup();
    await store.create(await member());
    const get = vi.spyOn(store, "get");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => login(deps, { id: "kasou-taro", password: `wrong-password-${i}` })),
    );
    expect(get.mock.calls.length).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.location === "/login?error=locked").length).toBeGreaterThanOrEqual(15);
  });

  it("★長さは決まりと同じ数え方（そろえたあとの文字数）。決めてよいパスワードなら入れる", async () => {
    const { store, deps } = setup();
    // 半角の濁点つきカナは、そろえる前は2倍の長さになる
    const long = "ｶﾞ".repeat(100);
    await store.create(await member({ hash: await hashPassword(long, FAST) }));
    expect((await login(deps, { id: "kasou-taro", password: long })).location).toBe("/");
  });

  it("★メモリの回数制限は Redis の手前で止める（連打で無料枠を使い切らせない）", async () => {
    const { store } = setup();
    const snapshot = vi.spyOn(store, "reserveAttempt");
    const limiter = createKeyedLimiter({ windowMs: 60_000, max: 1 });
    await login({ store, limiter, scrypt: FAST }, { id: "kasou-taro", password: "x" });
    const second = await login({ store, limiter, scrypt: FAST }, { id: "kasou-taro", password: "x" });
    expect(second.location).toBe("/login?error=locked");
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("止めたアカウント・仮のパスワードの期限切れは、パスワードが合っていたときだけ言う", async () => {
    const { store, deps } = setup();
    await store.create(await member({ disabled: true }));
    expect((await login(deps, { id: "kasou-taro", password: "wrong-password" })).location).toBe("/login?error=1");
    expect((await login(deps, { id: "kasou-taro", password: "sakura-tanbo" })).location).toBe("/login?error=disabled");
    await store.create(
      await member({ id: "kasou-hanako", hash: await hashPassword(canonicalTemp("ab2c-defg-hjk3"), FAST), mustChange: true, tempExpiresAt: NOW_MS - 1 }),
    );
    expect((await login(deps, { id: "kasou-hanako", password: "ab2c-defg-hjk3" })).location).toBe("/login?error=temp-expired");
  });

  it("★仮のパスワードは大文字・ハイフン無しで打っても入れ、まずパスワードを決める画面へ", async () => {
    const { store, deps } = setup();
    await store.create(
      await member({ hash: await hashPassword(canonicalTemp("ab2c-defg-hjk3"), FAST), mustChange: true, tempExpiresAt: NOW_MS + 86_400_000 }),
    );
    const result = await login(deps, { id: "kasou-taro", password: "AB2CDEFGHJK3", next: "/after" });
    expect(result.location).toBe("/account?next=%2Fafter");
    const claims = claimsFrom(result.cookies);
    expect(claims?.mc).toBe(1);
    expect((claims?.exp ?? 0) - NOW).toBeLessThanOrEqual(12 * 3600);
  });

  it("置き場所に届かなければ、いま確かめられないと出す", async () => {
    const { store, limiter } = setup();
    vi.spyOn(store, "reserveAttempt").mockRejectedValue(new StoreUnavailableError());
    const result = await login({ store, limiter, scrypt: FAST }, { id: "kasou-taro", password: "sakura-tanbo" });
    expect(result.location).toBe("/login?error=unavailable");
  });
});

// ---------------------------------------------------------------------------
describe("最初の管理者", () => {
  const CODE = "kasu-2abc-3def";
  const bootstrapFor = async (exp = NOW + 3600) =>
    formatBootstrap({ expSec: exp, loginId: "kasou-admin", hash: await hashPassword(canonicalTemp(CODE), FAST), name: null });

  it("★値に「$」を含めない（.env で読み込むと $1 などが展開されて壊れるため）", async () => {
    expect(await bootstrapFor()).not.toContain("$");
  });

  it("右上の名前も渡せる（日本語でも）", async () => {
    const hash = await hashPassword(canonicalTemp(CODE), FAST);
    const value = formatBootstrap({ expSec: NOW + 3600, loginId: "kasou-admin", hash, name: "架空 管理" });
    expect(parseBootstrap(value)).toMatchObject({ loginId: "kasou-admin", name: "架空 管理" });
    const { store, deps } = setup();
    await login(deps, { id: "kasou-admin", password: CODE }, { config: config({ bootstrap: value }) });
    expect((await store.get("kasou-admin"))?.name).toBe("架空 管理");
  });

  it("形を読み書きできる。おかしな値は無視する", async () => {
    const value = await bootstrapFor();
    expect(parseBootstrap(value)).toMatchObject({ loginId: "kasou-admin" });
    for (const bad of ["", "x", "1:KASOU:scrypt$x", "0:kasou-admin:scrypt$x", "1:kasou-admin:plain"]) {
      expect(parseBootstrap(bad)).toBeNull();
    }
  });

  it("コードで入ると管理者ができ、すぐパスワードを決める画面へ。★2回目は使えない", async () => {
    const { store, deps } = setup();
    const cfg = config({ bootstrap: await bootstrapFor() });
    const first = await login(deps, { id: "kasou-admin", password: CODE.toUpperCase() }, { config: cfg });
    expect(first.location).toBe("/account");
    expect(claimsFrom(first.cookies)?.mc).toBe(1);
    expect(await store.get("kasou-admin")).toMatchObject({ role: "admin", mustChange: true, name: "管理者" });
    // パスワードを決めたあとでも、同じコードでは入り直せない
    await store.update("kasou-admin", (r) => ({ ...r, hash: "scrypt$1$10.8.1$x$y", mustChange: false }));
    const again = await login(deps, { id: "kasou-admin", password: CODE }, { config: cfg });
    expect(again.location).toBe("/login?error=1");
  });

  it("★印はコードの期限より長く残る（期限の前に印だけ消えて、同じコードでまた入れることが無い）", async () => {
    const { deps } = setup();
    const bootstrap = await bootstrapFor(NOW + 90 * 86_400);
    const mark = vi.spyOn(deps.store, "markBootstrapUsed");
    await login(deps, { id: "kasou-admin", password: CODE }, { config: config({ bootstrap }) });
    expect(mark.mock.calls[0][1]).toBeGreaterThan(90 * 86_400);
  });

  it("★管理者を書けなかったら印を外す（コードを無駄にしない）", async () => {
    const { store, deps } = setup();
    const cfg = config({ bootstrap: await bootstrapFor() });
    vi.spyOn(store, "upsert").mockResolvedValueOnce(null);
    expect((await login(deps, { id: "kasou-admin", password: CODE }, { config: cfg })).location).toBe("/login?error=1");
    expect((await login(deps, { id: "kasou-admin", password: CODE }, { config: cfg })).location).toBe("/account");
  });

  it("★その ID が止められていても、最初の管理者のコードでは入れる（回復の道を残す）", async () => {
    const { deps } = setup();
    const cfg = config({ bootstrap: await bootstrapFor() });
    for (let i = 0; i < 6; i += 1) await login(deps, { id: "kasou-admin", password: `wrong-${i}` }, { config: cfg });
    expect((await login(deps, { id: "kasou-admin", password: "still-wrong" }, { config: cfg })).location).toBe("/login?error=locked");
    expect((await login(deps, { id: "kasou-admin", password: CODE }, { config: cfg })).location).toBe("/account");
  });

  it("★秘密を変えても、使った印は消えない（印のキーに秘密を混ぜない）", async () => {
    const { deps } = setup();
    const bootstrap = await bootstrapFor();
    await login(deps, { id: "kasou-admin", password: CODE }, { config: config({ bootstrap }) });
    await deps.store.update("kasou-admin", (r) => ({ ...r, mustChange: false, hash: "scrypt$1$10.8.1$x$y" }));
    const rotated = config({ bootstrap, secret: `${SECRET}-rotated` });
    expect((await login(deps, { id: "kasou-admin", password: CODE }, { config: rotated })).location).toBe("/login?error=1");
  });

  it("★ほかの ID の失敗では使い切られない。期限切れのコードは使えない", async () => {
    const { deps } = setup();
    const cfg = config({ bootstrap: await bootstrapFor() });
    await login(deps, { id: "kasou-other", password: CODE }, { config: cfg });
    await login(deps, { id: "kasou-admin", password: "wrong-code" }, { config: cfg });
    expect((await login(deps, { id: "kasou-admin", password: CODE }, { config: cfg })).location).toBe("/account");
    const expired = config({ bootstrap: await bootstrapFor(NOW - 1) });
    const other = setup();
    expect((await login(other.deps, { id: "kasou-admin", password: CODE }, { config: expired })).location).toBe("/login?error=1");
  });
});

// ---------------------------------------------------------------------------
describe("パスワードを変える", () => {
  const change = (
    deps: { store: AccountStore; limiter: ReturnType<typeof createKeyedLimiter>; scrypt: typeof FAST },
    claims: SessionClaims | null,
    form: { current?: string; password: string; confirm?: string; next?: string },
    origin = SAME,
  ) =>
    handleChangePassword(
      {
        config: config(),
        origin,
        claims,
        form: { current: form.current ?? "", password: form.password, confirm: form.confirm ?? form.password, next: form.next ?? "/" },
        secure: true,
        nowMs: NOW_MS,
      },
      deps,
    );

  it("★仮のパスワードの人は、今のパスワードを聞かずに決められる。決めたら行きたかった画面へ", async () => {
    const { store, deps } = setup();
    const temp = await member({ hash: await hashPassword(canonicalTemp("ab2c-defg-hjk3"), FAST), mustChange: true, tempExpiresAt: NOW_MS + 1000 });
    await store.create(temp);
    const claims: SessionClaims = { u: temp.id, sv: temp.sv, mc: 1, chk: NOW, exp: NOW + 3600 };
    const result = await change(deps, claims, { password: "yama-no-michi", next: "/after" });
    expect(result.location).toBe("/after");
    const saved = await store.get(temp.id);
    expect(saved).toMatchObject({ mustChange: false, tempExpiresAt: null, sv: NOW_MS, passwordChangedAt: NOW_MS });
    expect(claimsFrom(result.cookies)).toMatchObject({ mc: 0, sv: NOW_MS });
  });

  it("★仮のパスワードと同じもの・決まりに合わないものは断る（理由の記号を返す）", async () => {
    const { store, deps } = setup();
    const temp = await member({ hash: await hashPassword(canonicalTemp("ab2c-defg-hjk3"), FAST), mustChange: true, tempExpiresAt: NOW_MS + 1000 });
    await store.create(temp);
    const claims: SessionClaims = { u: temp.id, sv: temp.sv, mc: 1, chk: NOW, exp: NOW + 3600 };
    expect((await change(deps, claims, { password: "AB2C-DEFG-HJK3" })).location).toBe("/account?error=policy&p=same");
    expect((await change(deps, claims, { password: "short" })).location).toBe("/account?error=policy&p=short");
  });

  it("いつでも変えるときは、今のパスワードを確かめる。変えたら『変えました』と出す", async () => {
    const { store, deps } = setup();
    const record = await member();
    await store.create(record);
    const claims: SessionClaims = { u: record.id, sv: record.sv, mc: 0, chk: NOW, exp: NOW + 3600 };
    expect((await change(deps, claims, { current: "wrong-password", password: "yama-no-michi" })).location).toBe(
      "/account?error=current",
    );
    const ok = await change(deps, claims, { current: "sakura-tanbo", password: "yama-no-michi" });
    expect(ok.location).toBe("/account?done=1");
  });

  it("★今のパスワードの当てずっぽうは5回で止める（盗まれた印で当て続けさせない）", async () => {
    const { store, deps } = setup();
    const record = await member();
    await store.create(record);
    const claims: SessionClaims = { u: record.id, sv: record.sv, mc: 0, chk: NOW, exp: NOW + 3600 };
    for (let i = 0; i < 5; i += 1) {
      expect((await change(deps, claims, { current: `guess-${i}`, password: "yama-no-michi" })).location).toBe("/account?error=current");
    }
    expect((await change(deps, claims, { current: "sakura-tanbo", password: "yama-no-michi" })).location).toBe(
      "/account?error=locked",
    );
  });

  it("★別のサイトからは断る。古い印（版が違う）ならログインし直し", async () => {
    const { store, deps } = setup();
    const record = await member();
    await store.create(record);
    const claims: SessionClaims = { u: record.id, sv: record.sv, mc: 0, chk: NOW, exp: NOW + 3600 };
    expect((await change(deps, claims, { current: "sakura-tanbo", password: "yama-no-michi" }, CROSS)).location).toBe(
      "/account?error=origin",
    );
    const stale = await change(deps, { ...claims, sv: 1 }, { current: "sakura-tanbo", password: "yama-no-michi" });
    expect(stale.location).toBe("/login?expired=1");
  });
});

// ---------------------------------------------------------------------------
describe("アカウントの管理", () => {
  const admin = async () => member({ id: "kasou-admin", name: "管理者", role: "admin" });
  const request = (deps: { store: AccountStore; scrypt: typeof FAST }, claims: SessionClaims | null, body: unknown, method: "GET" | "POST" = "POST", origin = SAME) =>
    handleAccountsRequest({ config: config(), method, origin, claims, body, nowMs: NOW_MS }, deps);
  const claimsOf = (r: AccountRecord, mc: 0 | 1 = 0): SessionClaims => ({ u: r.id, sv: r.sv, mc, chk: NOW, exp: NOW + 3600 });

  it("管理者だけが使える（止めた・版が違う・仮の入場なら使えない）", async () => {
    const { store } = setup();
    const m = await member();
    await store.create(m);
    expect((await request({ store, scrypt: FAST }, claimsOf(m), null, "GET")).status).toBe(403);
    const a = await admin();
    await store.create(a);
    expect((await request({ store, scrypt: FAST }, { ...claimsOf(a), sv: 1 }, null, "GET")).status).toBe(401);
    expect((await request({ store, scrypt: FAST }, claimsOf(a, 1), null, "GET")).status).toBe(401);
    expect((await request({ store, scrypt: FAST }, claimsOf(a), { action: "create", id: "kasou-x", name: "x" }, "POST", CROSS)).status).toBe(403);
  });

  it("★作ると仮のパスワードを1回だけ返す。一覧にハッシュは出ない。同じ ID は作れない", async () => {
    const { store } = setup();
    const a = await admin();
    await store.create(a);
    const created = await request({ store, scrypt: FAST }, claimsOf(a), { action: "create", id: "Kasou-Hanako", name: "架空 花子" });
    expect(created.status).toBe(200);
    expect(created.body.tempPassword).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
    expect(created.body.tempFor).toBe("kasou-hanako");
    expect(JSON.stringify(created.body.accounts)).not.toContain("scrypt");
    expect((await store.get("kasou-hanako"))).toMatchObject({ role: "member", mustChange: true, tempExpiresAt: NOW_MS + 7 * 86_400_000 });
    const list = await request({ store, scrypt: FAST }, claimsOf(a), null, "GET");
    expect(list.body.tempPassword).toBeUndefined();
    const dup = await request({ store, scrypt: FAST }, claimsOf(a), { action: "create", id: "kasou-hanako", name: "x" });
    expect(dup.status).toBe(409);
  });

  it("仮のパスワードの発行・停止で版が変わる（その人のログインが切れる）。再開・削除もできる", async () => {
    const { store } = setup();
    const a = await admin();
    await store.create(a);
    await store.create(await member());
    const reset = await request({ store, scrypt: FAST }, claimsOf(a), { action: "reset", id: "kasou-taro" });
    expect(reset.body.tempPassword).toBeTruthy();
    expect(await store.get("kasou-taro")).toMatchObject({ mustChange: true, sv: NOW_MS });
    await request({ store, scrypt: FAST }, claimsOf(a), { action: "disable", id: "kasou-taro" });
    expect((await store.get("kasou-taro"))?.disabled).toBe(true);
    await request({ store, scrypt: FAST }, claimsOf(a), { action: "enable", id: "kasou-taro" });
    expect((await store.get("kasou-taro"))?.disabled).toBe(false);
    await request({ store, scrypt: FAST }, claimsOf(a), { action: "delete", id: "kasou-taro" });
    expect(await store.get("kasou-taro")).toBeNull();
  });

  it("★自分自身は止めない・消さない・仮パスワードにしない", () => {
    for (const action of ["reset", "disable", "delete"]) {
      expect(planAdminAction({ action, id: "kasou-admin" }, "kasou-admin")).toMatchObject({ ok: false });
    }
    expect(planAdminAction({ action: "grant", id: "kasou-x" }, "kasou-admin")).toMatchObject({ ok: false });
    expect(planAdminAction({ action: "create", id: "X", name: "x" }, "kasou-admin")).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
describe("今ある API のルートの確かめ（Redis は使わない）", () => {
  const req = (cookie?: string) => new Request("https://folio.invalid/api/summarize", { headers: cookie ? { cookie } : {} });
  const token = (c: Partial<SessionClaims> = {}) =>
    signSession({ u: "kasou-taro", sv: 1, mc: 0, chk: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...c }, SECRET);

  it("アカウントを使わない手元では通す。設定が足りなければ 503", async () => {
    expect(await requireSignedIn(req(), { kind: "off" })).toEqual({ ok: true, id: null });
    const broken = await requireSignedIn(req(), { kind: "broken", missing: [] });
    expect(broken.ok ? 0 : broken.response.status).toBe(503);
  });

  it("印が正しければ通す（ID が分かる）。無い・仮の入場は 401", async () => {
    expect(await requireSignedIn(req(`folio_session=${token()}`), config())).toEqual({ ok: true, id: "kasou-taro" });
    const none = await requireSignedIn(req(), config());
    expect(none.ok ? 0 : none.response.status).toBe(401);
    const temp = await requireSignedIn(req(`folio_session=${token({ mc: 1 })}`), config());
    expect(temp.ok ? 0 : temp.response.status).toBe(401);
  });

  it("旧合言葉のクッキーは、APP_PASSWORD がある間だけ通す", async () => {
    const v1 = await createSessionToken("user", "kasou-shared", 3600);
    const withLegacy = config({ legacy: { user: "user", password: "kasou-shared", untilSec: Math.floor(Date.now() / 1000) + 3600 } });
    expect(await requireSignedIn(req(`folio_session=${v1}`), withLegacy)).toEqual({ ok: true, id: null });
    const without = await requireSignedIn(req(`folio_session=${v1}`), config());
    expect(without.ok).toBe(false);
  });
});

describe("★前の合言葉の印（切り替えの間だけ）", () => {
  it("期限を好きに書いた印は受け付けない（ログインを保つ日数より先の期限）", async () => {
    const { readSession } = await import("@/lib/account/session");
    const nowSec = Math.floor(Date.now() / 1000);
    const withLegacy = config({ legacy: { user: "user", password: "kasou-shared", untilSec: nowSec + 7 * 86_400 } });
    const normal = await createSessionToken("user", "kasou-shared", 30 * 86_400);
    expect(await readSession(normal, withLegacy, nowSec)).toEqual({ kind: "legacy" });
    const forged = await createSessionToken("user", "kasou-shared", 3650 * 86_400);
    expect(await readSession(forged, withLegacy, nowSec)).toEqual({ kind: "none", hadToken: true });
  });

  it("★受け付ける期限（FOLIO_LEGACY_UNTIL）を過ぎたら、前の合言葉を消し忘れても通らない", async () => {
    const { readSession } = await import("@/lib/account/session");
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await createSessionToken("user", "kasou-shared", 86_400);
    const expired = config({ legacy: { user: "user", password: "kasou-shared", untilSec: nowSec - 1 } });
    expect(await readSession(token, expired, nowSec)).toEqual({ kind: "none", hadToken: true });
  });
});

describe("表示名を変える", () => {
  const rename = (store: AccountStore, claims: SessionClaims | null, name: string, origin = SAME) =>
    handleRename({ config: config(), origin, claims, form: { name }, secure: true, nowMs: NOW_MS }, { store });

  it("自分の表示名を変えると、右上の名前がすぐ変わる（ログインは切れない＝版は変わらない）", async () => {
    const { store } = setup();
    const record = await member();
    await store.create(record);
    const claims: SessionClaims = { u: record.id, sv: record.sv, mc: 0, chk: NOW, exp: NOW + 3600 };
    const result = await rename(store, claims, "  架空 太郎（営業）  ");
    expect(result.location).toBe("/account?done=name");
    expect(await store.get(record.id)).toMatchObject({ name: "架空 太郎（営業）", sv: record.sv });
    const marker = readSignedInMarker(result.cookies.find((c) => c.name === "folio_signed_in")?.value);
    expect(marker).toMatchObject({ name: "架空 太郎（営業）" });
    // ★ログインの期限は延ばさない
    expect(claimsFrom(result.cookies)?.exp).toBe(claims.exp);
  });

  it("決まりに合わない名前・別のサイト・仮の入場・古い印は断る", async () => {
    const { store } = setup();
    const record = await member();
    await store.create(record);
    const claims: SessionClaims = { u: record.id, sv: record.sv, mc: 0, chk: NOW, exp: NOW + 3600 };
    expect((await rename(store, claims, "   ")).location).toBe("/account?error=name-empty");
    expect((await rename(store, claims, "あ".repeat(21))).location).toBe("/account?error=name-long");
    expect((await rename(store, claims, "架空", CROSS)).location).toBe("/account?error=origin");
    expect((await rename(store, { ...claims, mc: 1 }, "架空")).location).toBe("/login?expired=1");
    expect((await rename(store, { ...claims, sv: 1 }, "架空")).location).toBe("/login?expired=1");
    expect((await store.get(record.id))?.name).toBe("架空 太郎");
  });

  it("管理者は、ほかの人の表示名を変えられる（その人のログインは切れない）。自分はこの操作では変えない", async () => {
    const { store } = setup();
    const a = await member({ id: "kasou-admin", name: "管理者", role: "admin" });
    const m = await member();
    await store.create(a);
    await store.create(m);
    const claims: SessionClaims = { u: a.id, sv: a.sv, mc: 0, chk: NOW, exp: NOW + 3600 };
    const result = await handleAccountsRequest(
      { config: config(), method: "POST", origin: SAME, claims, body: { action: "rename", id: m.id, name: "架空 太郎（経理）" }, nowMs: NOW_MS },
      { store, scrypt: FAST },
    );
    expect(result.status).toBe(200);
    expect(await store.get(m.id)).toMatchObject({ name: "架空 太郎（経理）", sv: m.sv });
    expect(planAdminAction({ action: "rename", id: "kasou-admin", name: "x" }, "kasou-admin")).toMatchObject({ ok: false });
    expect(planAdminAction({ action: "rename", id: m.id, name: "" }, "kasou-admin")).toMatchObject({ ok: false });
  });
});
