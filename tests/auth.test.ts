import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  isValidCredentials,
  parseBasicAuth,
  safeEqual,
  sessionMaxAgeSeconds,
  verifySessionToken,
} from "@/lib/auth";

const USER = "user";
const PASSWORD = "架空のパスワード";
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60;

describe("セッションの署名", () => {
  it("作った値は同じユーザー・パスワードで通る", async () => {
    const token = await createSessionToken(USER, PASSWORD, 30 * DAY, NOW);
    expect(await verifySessionToken(token, USER, PASSWORD, NOW)).toBe(true);
  });

  it("中身にパスワードは入らない (有効期限と署名だけ)", async () => {
    const token = await createSessionToken(USER, PASSWORD, 30 * DAY, NOW);
    expect(token).not.toContain(PASSWORD);
    expect(token.split(".")).toHaveLength(3);
    expect(token.startsWith("v1.")).toBe(true);
  });

  it("期限を過ぎたら通らない", async () => {
    const token = await createSessionToken(USER, PASSWORD, DAY, NOW);
    expect(await verifySessionToken(token, USER, PASSWORD, NOW + DAY * 1000 - 1)).toBe(true);
    expect(await verifySessionToken(token, USER, PASSWORD, NOW + DAY * 1000 + 1)).toBe(false);
  });

  it("パスワードを変えると前のセッションは無効になる", async () => {
    const token = await createSessionToken(USER, PASSWORD, 30 * DAY, NOW);
    expect(await verifySessionToken(token, USER, "別のパスワード", NOW)).toBe(false);
  });

  it("ユーザー名が違えば通らない", async () => {
    const token = await createSessionToken(USER, PASSWORD, 30 * DAY, NOW);
    expect(await verifySessionToken(token, "someone", PASSWORD, NOW)).toBe(false);
  });

  it("期限を書き換えても署名が合わない", async () => {
    const token = await createSessionToken(USER, PASSWORD, DAY, NOW);
    const [, exp, sig] = token.split(".");
    const forged = `v1.${Number(exp) + 10 * DAY}.${sig}`;
    expect(await verifySessionToken(forged, USER, PASSWORD, NOW)).toBe(false);
  });

  it("壊れた値・空でも落ちない", async () => {
    for (const token of [undefined, "", "abc", "v1.x.y", "v2.1.2", "v1.1"]) {
      expect(await verifySessionToken(token, USER, PASSWORD, NOW)).toBe(false);
    }
  });
});

describe("sessionMaxAgeSeconds", () => {
  it("既定は30日", () => {
    expect(sessionMaxAgeSeconds(undefined)).toBe(30 * DAY);
  });

  it("APP_SESSION_DAYS で変えられる", () => {
    expect(sessionMaxAgeSeconds("7")).toBe(7 * DAY);
  });

  it("おかしな値は既定に戻す", () => {
    for (const raw of ["0", "-1", "abc", "", "9999"]) {
      expect(sessionMaxAgeSeconds(raw)).toBe(30 * DAY);
    }
  });
});

describe("isValidCredentials", () => {
  it("両方合っているときだけ通す", () => {
    expect(isValidCredentials(USER, PASSWORD, USER, PASSWORD)).toBe(true);
    expect(isValidCredentials(USER, "違う", USER, PASSWORD)).toBe(false);
    expect(isValidCredentials("違う", PASSWORD, USER, PASSWORD)).toBe(false);
    expect(isValidCredentials("", "", USER, PASSWORD)).toBe(false);
  });
});

describe("safeEqual", () => {
  it("同じなら true、違えば false (長さが違っても)", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("parseBasicAuth", () => {
  it("Basic ヘッダーからユーザー名とパスワードを取る", () => {
    const header = `Basic ${btoa("user:pass:word")}`;
    expect(parseBasicAuth(header)).toEqual({ user: "user", password: "pass:word" });
  });

  it("形式が違えば null", () => {
    expect(parseBasicAuth("")).toBeNull();
    expect(parseBasicAuth("Bearer xxx")).toBeNull();
    expect(parseBasicAuth("Basic !!!")).toBeNull();
    expect(parseBasicAuth(`Basic ${btoa("nocolon")}`)).toBeNull();
    expect(parseBasicAuth(`Basic ${btoa(":pass")}`)).toBeNull();
  });
});
