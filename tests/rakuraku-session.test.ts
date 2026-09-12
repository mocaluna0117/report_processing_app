import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionError, seal, unseal } from "@/lib/rakuraku/session";

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
});
