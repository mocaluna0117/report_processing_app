import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isSameOriginPost } from "@/lib/account/origin";
import { safeNextPath, sessionMaxAgeSeconds } from "@/lib/auth";

const DAY = 24 * 60 * 60;

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

describe("ログイン後の戻り先（外部サイトへ飛ばさない）", () => {
  it("アプリの中のパスはそのまま戻す", () => {
    expect(safeNextPath("/after")).toBe("/after");
    expect(safeNextPath("/tenmatsu?x=1")).toBe("/tenmatsu?x=1");
    expect(safeNextPath("/")).toBe("/");
  });

  it("★抜け道をすべて塞ぐ（ブラウザが別サイトと読むもの）", () => {
    const vectors = [
      "//evil.com",
      "/\\evil.com",
      "/\\/evil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r/evil.com",
      "/.//evil.com",
      "/..//evil.com",
      "/%2e//evil.com",
      "/a/..//evil.com",
      "/%5cevil.com",
      "https://evil.com/",
      "http:/evil.com",
      "evil.com",
      "javascript:alert(1)",
      " /after",
    ];
    for (const raw of vectors) expect(safeNextPath(raw), JSON.stringify(raw)).toBe("/");
  });

  it("ログインの画面・API・長すぎるもの・文字列でないものは戻り先にしない", () => {
    expect(safeNextPath("/login")).toBe("/");
    expect(safeNextPath("/login?next=/after")).toBe("/");
    expect(safeNextPath("/api/logout")).toBe("/");
    expect(safeNextPath(`/${"a".repeat(600)}`)).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(["/after"])).toBe("/");
  });

  it("Next の内部の目印（_rsc）は捨てる", () => {
    expect(safeNextPath("/after?_rsc=abc&x=1")).toBe("/after?x=1");
  });
});

describe("別のサイトからの送信を断る", () => {
  const url = "https://folio.example.vercel.app/api/login";

  it("同じサイトからのフォームの送信は通す", () => {
    expect(isSameOriginPost({ url, fetchSite: "same-origin", origin: "https://folio.example.vercel.app" })).toBe(true);
    // Sec-Fetch-Site が無い古いブラウザでも、Origin が同じなら通す
    expect(isSameOriginPost({ url, fetchSite: null, origin: "https://folio.example.vercel.app" })).toBe(true);
  });

  it("★別のサイト・分からないものは断る", () => {
    expect(isSameOriginPost({ url, fetchSite: "cross-site", origin: "https://evil.example" })).toBe(false);
    expect(isSameOriginPost({ url, fetchSite: "same-site", origin: "https://other.vercel.app" })).toBe(false);
    expect(isSameOriginPost({ url, fetchSite: "none", origin: null })).toBe(false);
    expect(isSameOriginPost({ url, fetchSite: null, origin: "https://evil.example" })).toBe(false);
    expect(isSameOriginPost({ url, fetchSite: null, origin: null })).toBe(false);
  });

  it("★Origin: null や壊れた値でも例外を出さない", () => {
    expect(() => isSameOriginPost({ url, fetchSite: null, origin: "null" })).not.toThrow();
    expect(isSameOriginPost({ url, fetchSite: null, origin: "null" })).toBe(false);
    expect(isSameOriginPost({ url, fetchSite: null, origin: "::::" })).toBe(false);
  });
});

describe("★門番（中身を読んで見張る）", () => {
  const source = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");
  /** 説明文（コメント）を除いた中身 */
  const code = (path: string) => source(path).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  it("Basic 認証は受け付けない", () => {
    expect(code("proxy.ts")).not.toMatch(/parseBasicAuth|authorization/i);
    expect(code("lib/auth.ts")).not.toContain("parseBasicAuth");
  });

  it("門番の判断は lib/account/gate.ts に任せる（Vercel の上で設定が無ければ閉じる規則もそこ）", () => {
    expect(code("proxy.ts")).toContain("decideAccess(");
    expect(code("lib/account/config.ts")).toContain('env.VERCEL === "1"');
  });

  it("ログイン・ログアウトは、別のサイトからの送信を断る", () => {
    expect(source("app/api/logout/route.ts")).toContain("isSameOriginPost(originInputOf(request))");
    // ログインは handleLogin の最初で確かめる
    expect(source("app/api/login/route.ts")).toContain("origin: originInputOf(request)");
    const login = code("lib/account/login.ts");
    expect(login.indexOf("isSameOriginPost(input.origin)")).toBeGreaterThan(-1);
    expect(login.indexOf("isSameOriginPost(input.origin)")).toBeLessThan(login.indexOf("reserveAttempt"));
  });

  it("lib/auth.ts は画面からも読まれるので、秘密や node:crypto を入れない", () => {
    const auth = code("lib/auth.ts");
    expect(auth).not.toContain("node:crypto");
    expect(auth).not.toContain("server-only");
    expect(auth).not.toContain("process.env.APP_PASSWORD");
  });

  it("★前の合言葉の印（v1）を作る・確かめる部品は、もう無い（2026-09-25 にやめた）", () => {
    const auth = code("lib/auth.ts");
    for (const name of ["createSessionToken", "verifySessionToken", "isValidCredentials"]) expect(auth).not.toContain(name);
    expect(code("lib/account/session.ts")).not.toContain('"v1."');
  });
});

describe("Folio のログインが切れたときの文", () => {
  it("401 はログインが切れたと言う。ほかは今までどおり", async () => {
    const { SESSION_LOST_TEXT, apiFailureText } = await import("@/lib/api-error");
    expect(apiFailureText("summarize", 401)).toBe(SESSION_LOST_TEXT);
    expect(SESSION_LOST_TEXT).toContain("読み込み直してログイン");
    expect(apiFailureText("summarize", 500)).toBe("summarize API 500");
  });

  it("★要約・工事区分・カナ読み・アフターの要約の4か所が使う（中身を読んで見張る）", () => {
    const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
    const process = read("lib/process.ts");
    for (const label of ["summarize", "work-categories", "name-reading"]) {
      expect(process).toContain(`apiFailureText("${label}", res.status)`);
    }
    expect(read("lib/after/summarize-inquiry.ts")).toContain('apiFailureText("summarize", res.status)');
    expect(process).not.toMatch(/API \$\{res\.status\}/);
  });
});
