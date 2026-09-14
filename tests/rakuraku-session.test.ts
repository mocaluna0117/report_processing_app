import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_TTL_MS, SessionError, reseal, seal, unseal } from "@/lib/rakuraku/session";

const SECRET = "test-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const saved = process.env.RAKURAKU_SESSION_SECRET;

beforeEach(() => {
  process.env.RAKURAKU_SESSION_SECRET = SECRET;
});
afterEach(() => {
  if (saved === undefined) delete process.env.RAKURAKU_SESSION_SECRET;
  else process.env.RAKURAKU_SESSION_SECRET = saved;
});

const STATE = JSON.stringify({ cookies: [{ name: "JSESSIONID", value: "架空の値" }], origins: [] });
const HOME = "https://example.test/abcd/top";
const INPUT = { state: STATE, home: HOME };

describe("ログイン状態の封印", () => {
  it("封じて開くと元に戻る", () => {
    const opened = unseal(seal(INPUT));
    expect(opened.state).toBe(STATE);
    expect(opened.home).toBe(HOME);
  });

  it("★中身がそのまま見えない (クッキーは持っている人が成りすませる)", () => {
    const token = seal(INPUT);
    expect(token).not.toContain("JSESSIONID");
    expect(token).not.toContain("架空の値");
  });

  it("毎回違う値になる (同じ入力でも使い回せない)", () => {
    expect(seal(INPUT)).not.toBe(seal(INPUT));
  });

  it("★1文字でも書き換えられていたら開かない", () => {
    const token = seal(INPUT);
    const broken = `${token.slice(0, -2)}${token.slice(-1) === "A" ? "B" : "A"}`;
    expect(() => unseal(broken)).toThrow(SessionError);
  });

  it("★別の鍵では開けない", () => {
    const token = seal(INPUT);
    process.env.RAKURAKU_SESSION_SECRET = `${SECRET}-ちがう`;
    expect(() => unseal(token)).toThrow("読めませんでした");
  });

  it("形が違えば開かない", () => {
    expect(() => unseal("これはトークンではない")).toThrow("形が不正");
  });

  it("★期限が切れていれば拒む", () => {
    const token = seal(INPUT, -1);
    expect(() => unseal(token)).toThrow("期限が切れて");
  });

  it("鍵が短すぎれば封じさせない", () => {
    process.env.RAKURAKU_SESSION_SECRET = "みじかい";
    expect(() => seal(INPUT)).toThrow("32文字以上");
  });

  it("鍵が無ければ封じさせない", () => {
    delete process.env.RAKURAKU_SESSION_SECRET;
    expect(() => seal(INPUT)).toThrow("未設定");
  });

  it("★鍵が無いことは「ログインし直し」と区別できる（利用者のせいではない）", () => {
    const reasonOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e instanceof SessionError ? e.reason : "SessionError ではない";
      }
      return "投げなかった";
    };
    delete process.env.RAKURAKU_SESSION_SECRET;
    expect(reasonOf(() => seal(INPUT))).toBe("secret");
    process.env.RAKURAKU_SESSION_SECRET = SECRET;
    const expired = seal(INPUT, -1);
    expect(reasonOf(() => unseal(expired))).toBe("expired");
    expect(reasonOf(() => unseal("a.b.c"))).toBe("invalid");
  });
});

describe("メニューで見つけた一覧の URL も封じて持ち回る", () => {
  it("種類ごとの URL が戻る", () => {
    const lists = { natsuin: "https://example.test/abcd/list?wf=8" };
    expect(unseal(seal({ ...INPUT, lists })).lists).toEqual(lists);
  });

  it("無ければ入れない", () => {
    expect(unseal(seal({ ...INPUT, lists: {} })).lists).toBeUndefined();
  });

  it("★知らない種類の URL が入っていたら開かない", () => {
    const token = seal({ ...INPUT, lists: { keihi: "https://example.test/x" } as never });
    expect(() => unseal(token)).toThrow("中身が不正");
  });

  it("★封じ直しても期限は延ばさない（使い続けるだけで永久に使える札にしない）", () => {
    const first = unseal(seal(INPUT, 60_000));
    const again = unseal(seal({ state: first.state, home: first.home, exp: first.exp }));
    expect(again.exp).toBe(first.exp);
  });
});

describe("封じ直し (部門を読んだとき)", () => {
  it("★期限を延ばさず、覚えた一覧のURLも落とさない", () => {
    const exp = Date.now() + 60_000;
    const lists = { tenmatsu: "https://example.test/abcd/list" };
    const first = unseal(seal({ ...INPUT, lists, exp }));
    const again = unseal(reseal(first, JSON.stringify({ cookies: [], origins: [] })));
    expect(again.exp).toBe(exp);
    expect(again.lists).toEqual(lists);
    expect(again.home).toBe(HOME);
    expect(again.state).toBe(JSON.stringify({ cookies: [], origins: [] }));
  });

  it("期限は8時間 (ブラウザが控えを戻すかの判定にも使う)", () => {
    expect(SESSION_TTL_MS).toBe(8 * 60 * 60 * 1000);
    const opened = unseal(seal(INPUT));
    expect(opened.exp - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 5_000);
    expect(opened.exp - Date.now()).toBeLessThanOrEqual(SESSION_TTL_MS);
  });
});
