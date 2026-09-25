import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryKv } from "@/lib/account/kv";
import { KEYS, createAccountStore } from "@/lib/account/store";
import {
  CredentialError,
  credentialIdHint,
  credentialKey,
  openCredential,
  sealCredential,
} from "@/lib/rakuraku/credential";
import {
  CREDENTIAL_KEYS,
  CREDENTIAL_LIMITS,
  type CredentialState,
  EMPTY_STATE,
  createCredentialStateStore,
  decideStart,
  parseCredentialState,
  settleStale,
} from "@/lib/rakuraku/credential-state";
import { judgeLanding } from "@/lib/rakuraku/login";
import { type AttemptResult, guardedLogin } from "@/lib/rakuraku/stored-login";

// 楽楽精算のIDとパスワードの登録（2026-09-25）。★値はすべて架空。
const SECRET = "kasou-rakuraku-secret-0123456789abcdefghij";
const saved = process.env.RAKURAKU_SESSION_SECRET;
beforeEach(() => {
  process.env.RAKURAKU_SESSION_SECRET = SECRET;
});
afterEach(() => {
  if (saved === undefined) delete process.env.RAKURAKU_SESSION_SECRET;
  else process.env.RAKURAKU_SESSION_SECRET = saved;
});

const NOW = 1_800_000_000_000;
const TARO = { folioId: "kasou-taro", createdAt: 1_700_000_000_000 };
const SECRET_VALUE = { u: "99-0001", p: "kasou-rakuraku-pass", ver: "ver-1", savedAt: NOW };

describe("控えを封じる・開く", () => {
  it("封じて開くと元に戻る。中身（ID・パスワード）はそのまま見えない", () => {
    const sealed = sealCredential(SECRET_VALUE, TARO);
    expect(sealed).not.toContain("kasou-rakuraku-pass");
    expect(sealed).not.toContain("99-0001");
    expect(openCredential(sealed, TARO)).toEqual(SECRET_VALUE);
    expect(sealCredential(SECRET_VALUE, TARO)).not.toBe(sealed);
  });

  it("★ほかのアカウント・同じ ID で作り直したアカウントでは開けない", () => {
    const sealed = sealCredential(SECRET_VALUE, TARO);
    expect(() => openCredential(sealed, { ...TARO, folioId: "kasou-hanako" })).toThrow(CredentialError);
    expect(() => openCredential(sealed, { ...TARO, createdAt: TARO.createdAt + 1 })).toThrow(CredentialError);
  });

  it("★書き換えた・鍵が変わった・形が違うものは開けない（中身を見せない）", () => {
    const sealed = sealCredential(SECRET_VALUE, TARO);
    const broken = `${sealed.slice(0, -2)}${sealed.slice(-1) === "A" ? "B" : "A"}`;
    expect(() => openCredential(broken, TARO)).toThrow(CredentialError);
    expect(() => openCredential(sealed, TARO, credentialKey("another-kasou-secret-0123456789abcdef"))).toThrow(CredentialError);
    for (const value of ["", "c1.a.b", "x.y.z.w", 42, null, "c1." + "A".repeat(3000)]) {
      expect(() => openCredential(value, TARO)).toThrow(CredentialError);
    }
  });

  it("鍵が無い・短いときは CREDENTIAL_KEY", () => {
    expect(() => credentialKey("short")).toThrow(CredentialError);
    delete process.env.RAKURAKU_SESSION_SECRET;
    try {
      sealCredential(SECRET_VALUE, TARO);
      expect.unreachable();
    } catch (e) {
      expect((e as CredentialError).code).toBe("CREDENTIAL_KEY");
    }
  });

  it("画面に出す ID は伏せ字（末尾2文字だけ）", () => {
    expect(credentialIdHint("99-0001")).toBe("••••01");
    expect(credentialIdHint(" 7 ")).toBe("••••7");
  });
});

describe("自動でログインしてよいかの決まり（純関数）", () => {
  const ready: CredentialState = { ...EMPTY_STATE, ver: "ver-1" };

  it("★自動は、登録があり・版が同じで・前回成功していたときだけ", () => {
    expect(decideStart(ready, { purpose: "auto", ver: "ver-1", now: NOW })).toEqual({ ok: true });
    expect(decideStart(EMPTY_STATE, { purpose: "auto", ver: "ver-1", now: NOW })).toMatchObject({ code: "CREDENTIAL_MISSING" });
    expect(decideStart(ready, { purpose: "auto", ver: "ver-0", now: NOW })).toMatchObject({ code: "CREDENTIAL_STALE" });
    const failed = { ...ready, failures: 1, lastFailAt: NOW - 10 * 60_000 };
    expect(decideStart(failed, { purpose: "auto", ver: "ver-1", now: NOW })).toMatchObject({ code: "CREDENTIAL_REJECTED" });
  });

  it("失敗のあと60秒は、どちらも受け付けない", () => {
    const justFailed = { ...ready, failures: 1, lastFailAt: NOW - 30_000 };
    expect(decideStart(justFailed, { purpose: "verify", ver: null, now: NOW })).toMatchObject({ code: "LOGIN_COOLDOWN", waitMs: 30_000 });
    expect(decideStart(justFailed, { purpose: "verify", ver: null, now: NOW + 30_000 })).toEqual({ ok: true });
  });

  it("確かめて保存は、3回続けて失敗したら1時間待つ", () => {
    const three = { ...ready, failures: CREDENTIAL_LIMITS.verifyFailLimit, lastFailAt: NOW - 10 * 60_000 };
    expect(decideStart(three, { purpose: "verify", ver: null, now: NOW })).toMatchObject({ code: "LOGIN_LIMIT" });
    expect(decideStart(three, { purpose: "verify", ver: null, now: NOW + 50 * 60_000 })).toEqual({ ok: true });
  });

  it("同時に2つは始めない。送ったまま止まったもの（150秒）は失敗として数える", () => {
    const flying = { ...ready, inFlight: { id: "a", at: NOW, phase: "submitted" as const, purpose: "auto" as const } };
    expect(decideStart(flying, { purpose: "auto", ver: "ver-1", now: NOW })).toMatchObject({ code: "LOGIN_IN_PROGRESS" });
    const settled = settleStale(flying, NOW + CREDENTIAL_LIMITS.inFlightStaleMs);
    expect(settled).toMatchObject({ inFlight: null, failures: 1, lastFailReason: "UNKNOWN_OUTCOME" });
    // 打つ前で止まったものは数えない
    const pre = { ...flying, inFlight: { ...flying.inFlight, phase: "pre" as const } };
    expect(settleStale(pre, NOW + CREDENTIAL_LIMITS.inFlightStaleMs)).toMatchObject({ inFlight: null, failures: 0 });
  });

  it("★壊れた中身は「失敗1回」とみなす（自動のログインをしない側に倒す）", () => {
    expect(parseCredentialState("{broken")).toMatchObject({ ver: null, failures: 1 });
    expect(parseCredentialState(JSON.stringify({ v: 2 }))).toMatchObject({ failures: 1 });
    expect(parseCredentialState(null)).toEqual(EMPTY_STATE);
  });

  it("着いた画面: パスワード欄があれば失敗、「ワークフロー」タブが見えたときだけ成功", () => {
    const base = { frames: 6, mainFrame: true, workflowTab: true, passwordFields: 0, unreadableFrames: 0 };
    expect(judgeLanding(base)).toBe("OK");
    expect(judgeLanding({ ...base, passwordFields: 1 })).toBe("LOGIN_FAILED");
    expect(judgeLanding({ ...base, workflowTab: false })).toBe("LOGIN_UNCONFIRMED");
  });
});

describe("★登録したIDとパスワードでのログインの流れ（ロックを避ける）", () => {
  const setup = () => {
    const kv = createMemoryKv(() => NOW);
    return { kv, states: createCredentialStateStore(kv) };
  };
  let clock = NOW;
  beforeEach(() => {
    clock = NOW;
  });
  const now = () => clock;
  const ok: AttemptResult<string> = { code: "OK", value: "token" };

  /** 楽楽精算に見立てた試し。送る前に beforeSubmit を呼ぶ（本物と同じ順） */
  const attemptWith = (result: AttemptResult<string>, sent: string[] = []) =>
    async (beforeSubmit: () => Promise<boolean>): Promise<AttemptResult<string>> => {
      if (!(await beforeSubmit())) return { code: "LOGIN_ABORTED", message: "取りやめ", submitted: false };
      sent.push("password");
      return result;
    };

  const verify = (states: ReturnType<typeof setup>["states"], result: AttemptResult<string>, sent?: string[]) =>
    guardedLogin({ states, folioId: "kasou-taro", purpose: "verify", ver: null, newVer: "ver-1", now }, attemptWith(result, sent));
  const auto = (states: ReturnType<typeof setup>["states"], result: AttemptResult<string>, sent?: string[], ver = "ver-1") =>
    guardedLogin({ states, folioId: "kasou-taro", purpose: "auto", ver, now }, attemptWith(result, sent));

  it("確かめて保存に成功すると、版が決まり、自動のログインが使えるようになる", async () => {
    const { states } = setup();
    expect(await auto(states, ok)).toMatchObject({ ok: false, code: "CREDENTIAL_MISSING" });
    expect(await verify(states, ok)).toEqual({ ok: true, value: "token" });
    expect(await states.get("kasou-taro", now())).toMatchObject({ ver: "ver-1", failures: 0, lastOkAt: NOW, inFlight: null });
    expect(await auto(states, ok)).toEqual({ ok: true, value: "token" });
  });

  it("★自動のログインが1回失敗したら、2回目は楽楽精算に送らない（別のサーバーから来ても）", async () => {
    const { kv, states } = setup();
    await verify(states, ok);
    const sent: string[] = [];
    const failed = await auto(states, { code: "LOGIN_FAILED", message: "違う", submitted: true }, sent);
    expect(failed).toMatchObject({ ok: false, code: "LOGIN_FAILED", retryable: false });
    expect(sent).toHaveLength(1);
    // 別のサーバー（同じ置き場所を見る別の入れ物）から、時間をおいて来ても送らない
    const another = createCredentialStateStore(kv);
    clock = NOW + 24 * 3600_000;
    expect(await auto(another, ok, sent)).toMatchObject({ ok: false, code: "CREDENTIAL_REJECTED" });
    expect(sent).toHaveLength(1);
    // 入れ直して確かめたら、また使える
    expect(await verify(another, ok, sent)).toMatchObject({ ok: true });
    expect(await auto(another, ok, sent)).toMatchObject({ ok: true });
  });

  it("★着いた画面で確かめられないときも失敗として数える", async () => {
    const { states } = setup();
    await verify(states, ok);
    await auto(states, { code: "LOGIN_UNCONFIRMED", message: "?", submitted: true });
    expect(await states.get("kasou-taro", now())).toMatchObject({ failures: 1, lastFailReason: "LOGIN_UNCONFIRMED" });
  });

  it("★打つ前の失敗（つながらない・欄が無い）は数えない", async () => {
    const { states } = setup();
    await verify(states, ok);
    const beforeSubmit = async (): Promise<AttemptResult<string>> => ({ code: "TENANT_UNREACHABLE", message: "x", submitted: false });
    const result = await guardedLogin({ states, folioId: "kasou-taro", purpose: "auto", ver: "ver-1", now }, beforeSubmit);
    expect(result).toMatchObject({ ok: false, code: "TENANT_UNREACHABLE" });
    expect(await states.get("kasou-taro", now())).toMatchObject({ failures: 0, inFlight: null });
    expect(await auto(states, ok)).toMatchObject({ ok: true });
  });

  it("★送ったあとで例外になったものは、成功したか分からないので失敗として数える", async () => {
    const { states } = setup();
    await verify(states, ok);
    const boom = async (beforeSubmit: () => Promise<boolean>): Promise<AttemptResult<string>> => {
      await beforeSubmit();
      throw new Error("ブラウザが落ちた");
    };
    await expect(guardedLogin({ states, folioId: "kasou-taro", purpose: "auto", ver: "ver-1", now }, boom)).rejects.toThrow();
    expect(await states.get("kasou-taro", now())).toMatchObject({ failures: 1, lastFailReason: "UNKNOWN_OUTCOME", inFlight: null });
  });

  it("★ブラウザを起こせない（送る前の例外）は数えない", async () => {
    const { states } = setup();
    await verify(states, ok);
    const busy = async (): Promise<AttemptResult<string>> => {
      throw new Error("BROWSER_BUSY");
    };
    await expect(guardedLogin({ states, folioId: "kasou-taro", purpose: "auto", ver: "ver-1", now }, busy)).rejects.toThrow();
    expect(await states.get("kasou-taro", now())).toMatchObject({ failures: 0, inFlight: null });
  });

  it("同じアカウントのログインは同時に1つだけ", async () => {
    const { states } = setup();
    await verify(states, ok);
    let release: () => void = () => undefined;
    const slow = async (beforeSubmit: () => Promise<boolean>): Promise<AttemptResult<string>> => {
      await beforeSubmit();
      await new Promise<void>((r) => {
        release = r;
      });
      return ok;
    };
    const first = guardedLogin({ states, folioId: "kasou-taro", purpose: "auto", ver: "ver-1", now }, slow);
    await new Promise((r) => setTimeout(r, 0));
    expect(await auto(states, ok)).toMatchObject({ ok: false, code: "LOGIN_IN_PROGRESS" });
    release();
    expect(await first).toMatchObject({ ok: true });
  });

  it("★ほかの画面で入れ直して版が変わったら、古い控えでは送らない", async () => {
    const { states } = setup();
    await verify(states, ok);
    const sent: string[] = [];
    expect(await auto(states, ok, sent, "ver-old")).toMatchObject({ ok: false, code: "CREDENTIAL_STALE" });
    expect(sent).toHaveLength(0);
  });

  it("自動のログインは1日20回まで（成功も数える）", async () => {
    const { states } = setup();
    await verify(states, ok);
    for (let i = 0; i < CREDENTIAL_LIMITS.autoPerDay; i += 1) expect(await auto(states, ok)).toMatchObject({ ok: true });
    const sent: string[] = [];
    expect(await auto(states, ok, sent)).toMatchObject({ ok: false, code: "LOGIN_LIMIT" });
    expect(sent).toHaveLength(0);
  });

  it("確かめて保存で失敗したときは、版を変えない（登録しない）。3回続くと1時間待つ", async () => {
    const { states } = setup();
    const wrong: AttemptResult<string> = { code: "LOGIN_FAILED", message: "違う", submitted: true };
    for (let i = 0; i < 3; i += 1) {
      expect(await verify(states, wrong)).toMatchObject({ ok: false, code: "LOGIN_FAILED" });
      clock += CREDENTIAL_LIMITS.failCooldownMs;
    }
    expect(await states.get("kasou-taro", now())).toMatchObject({ ver: null, failures: 3 });
    const sent: string[] = [];
    expect(await verify(states, ok, sent)).toMatchObject({ ok: false, code: "LOGIN_LIMIT" });
    expect(sent).toHaveLength(0);
  });

  it("登録を消すと自動は使えない。★失敗の回数は残る（消して入れ直しても、上限をすり抜けられない）", async () => {
    const { states } = setup();
    await verify(states, ok);
    await auto(states, { code: "LOGIN_FAILED", message: "違う", submitted: true });
    await states.unregister("kasou-taro");
    expect(await states.get("kasou-taro", now())).toMatchObject({ ver: null, failures: 1 });
  });

  it("アカウントを消すと、自動ログインの状態も消える（同じキー）", async () => {
    const kv = createMemoryKv(() => NOW);
    const states = createCredentialStateStore(kv);
    await guardedLogin({ states, folioId: "kasou-taro", purpose: "verify", ver: null, newVer: "v", now }, attemptWith(ok));
    expect(KEYS.rakuraku("kasou-taro")).toBe(CREDENTIAL_KEYS.state("kasou-taro"));
    await createAccountStore(kv).remove("kasou-taro");
    expect(await kv.mget([CREDENTIAL_KEYS.state("kasou-taro")])).toEqual([null]);
  });
});

describe("★口の作り（中身を読んで見張る）", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
  const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const FILES = [
    "lib/rakuraku/credential.ts",
    "lib/rakuraku/credential-state.ts",
    "lib/rakuraku/stored-login.ts",
    "lib/rakuraku/browser-login.ts",
    "lib/rakuraku/subject.ts",
    "app/api/rakuraku/credential/route.ts",
    "app/api/rakuraku/login/route.ts",
  ];

  it("パスワードを console に出さない・例外の文をそのまま返さない", () => {
    for (const p of FILES) {
      expect(code(p), p).not.toMatch(/console\./);
      // 例外の文を返してよいのは、1行目だけにしたとき・文を決めてある自前の例外（CredentialError・GuardError）だけ
      for (const line of code(p).split("\n").filter((l) => /\be\.message\b/.test(l))) {
        const safe = /e\.message\.split\("\\n"\)\[0\]/.test(line) || /instanceof (CredentialError|GuardError)[^:]*\?\s*e\.message|instanceof (CredentialError|GuardError)\) return fail\([^)]*e\.message/.test(line);
        expect(safe, `${p}: ${line.trim()}`).toBe(true);
      }
    }
  });

  it("登録を使う口は、同じサイトからと確かめられないものを断る（isSameOriginPost）", () => {
    expect(code("app/api/rakuraku/login/route.ts")).toContain("isSameOriginPost(originInputOf(request))");
    expect(code("app/api/rakuraku/credential/route.ts")).toContain("isSameOriginPost(originInputOf(request))");
  });

  it("ログインの口は ID とパスワードを受け取らない（控えだけ）", () => {
    const login = code("app/api/rakuraku/login/route.ts");
    expect(login).not.toMatch(/body\.password|\.password\b.*request/);
    expect(login).toContain("openCredential(credential, subject.binding)");
  });

  it("取得の口はどれも、持ち主（Folio のアカウント）を確かめて札を開く", () => {
    for (const name of ["scan", "fetch", "attachment", "survey", "departments"]) {
      expect(code(`app/api/rakuraku/${name}/route.ts`), name).toContain("sessionSubjectOf(signed.id)");
    }
  });
});
