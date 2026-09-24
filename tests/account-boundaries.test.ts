import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 一人ずつのアカウントへの切り替え（2026-09-24）の作りを、中身を読んで見張る。
const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** 説明文（コメント）を除いた中身 */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(ROOT, path)).isDirectory() ? walk(path) : [path];
  });

describe("API のルート", () => {
  /** ログインしていなくても使う口と、自分で印を確かめる口 */
  const OWN_CHECK = new Set([
    "app/api/login/route.ts",
    "app/api/logout/route.ts",
    "app/api/account/password/route.ts",
    "app/api/account/name/route.ts",
    "app/api/accounts/route.ts",
  ]);
  const routes = walk("app/api").filter((p) => p.endsWith("route.ts"));

  it("★ほかのすべてのルートが、自分でもログインを確かめる（proxy だけに頼らない）", () => {
    const missing = routes.filter((p) => !OWN_CHECK.has(p) && !code(p).includes("await requireSignedIn(request)"));
    expect(missing).toEqual([]);
    expect(routes.length).toBeGreaterThanOrEqual(14);
  });

  it("自分で確かめる口は、印を読んでから処理に渡す", () => {
    for (const p of ["app/api/account/password/route.ts", "app/api/account/name/route.ts", "app/api/accounts/route.ts"]) {
      expect(code(p), p).toContain("sessionOf(request, config)");
    }
  });
});

describe("画面とサーバーの境目", () => {
  const SERVER_ONLY = ["login", "change-password", "rename", "admin", "password", "kv", "store", "runtime", "current", "page-state"];

  it("★画面の部品（use client）は、サーバーのアカウントの部品を import しない", () => {
    const clientFiles = [...walk("components"), ...walk("lib"), ...walk("app")].filter(
      (p) => /\.tsx?$/.test(p) && /^["']use client["']/.test(read(p).trimStart()),
    );
    // ★型だけの import（import type）は消えるので構わない
    const bad = clientFiles.filter((p) =>
      SERVER_ONLY.some((m) => new RegExp(`^import (?!type )[^;]*from ["']@/lib/account/${m}["']`, "m").test(read(p))),
    );
    expect(bad).toEqual([]);
  });

  it("★門番（proxy）から読む部品は server-only を付けない（proxy は react-server の外で動く）", () => {
    for (const p of [
      "proxy.ts",
      "lib/account/gate.ts",
      "lib/account/session.ts",
      "lib/account/token.ts",
      "lib/account/runtime.ts",
      "lib/account/kv.ts",
      "lib/account/store.ts",
      "lib/account/config.ts",
      "lib/account/record.ts",
      "lib/auth.ts",
    ]) {
      expect(code(p), p).not.toContain("server-only");
    }
  });

  it("ログイン画面は、ログインIDを最初から入れない（誰でも開ける画面に ID を見せない）", () => {
    const page = code("app/login/page.tsx");
    expect(page).not.toContain("APP_USER");
    expect(page).not.toContain("defaultValue");
  });

  it("★前の合言葉は、ログインにもクッキーにも使わない（APP_PASSWORD を読むのは、手元で閉じる判断だけ）", () => {
    const users = [...walk("app"), ...walk("lib"), "proxy.ts"].filter(
      (p) => /\.tsx?$/.test(p) && /createSessionToken|verifySessionToken|APP_USER|FOLIO_LEGACY_UNTIL/.test(code(p)),
    );
    expect(users).toEqual([]);
    const readers = [...walk("app"), ...walk("lib"), "proxy.ts"].filter((p) => /\.tsx?$/.test(p) && code(p).includes("APP_PASSWORD"));
    expect(readers.map((p) => relative(ROOT, join(ROOT, p)))).toEqual(["lib/account/config.ts"]);
  });
});

describe("★ほかの端末でログインしたら、前の端末は読み込み直したときに切れる", () => {
  it("proxy は画面の読み込み（Sec-Fetch-Dest: document）を門番に伝え、門番は確かめる回数を増やすのにだけ使う", () => {
    const proxy = code("proxy.ts");
    expect(proxy).toContain('request.headers.get("sec-fetch-dest") === "document"');
    expect(proxy).toMatch(/decideAccess\(\s*\{[^}]*navigation[^}]*\}/);
    const gate = code("lib/account/gate.ts");
    expect(gate).toContain("const stale = input.navigation === true || nowSec - claims.chk >= RECHECK_SEC;");
    expect(gate.match(/navigation/g)?.length).toBe(2);
  });

  it("ログインは、入れる前に版を進める（takeOver）", () => {
    const login = code("lib/account/login.ts");
    expect(login.indexOf("takeOver(deps.store, record")).toBeGreaterThan(-1);
    expect(login.indexOf("takeOver(deps.store, record")).toBeLessThan(login.indexOf("return success(taken"));
  });
});

describe("★公開リポジトリに実物を書かない", () => {
  it("Upstash の実物の URL・長い秘密らしき値が無い", () => {
    const files = [...walk("app"), ...walk("lib"), ...walk("components"), ...walk("tests"), ...walk("scripts")].filter((p) =>
      /\.(tsx?|mts|mjs)$/.test(p),
    );
    for (const p of files) {
      const text = read(p);
      expect(text, p).not.toMatch(/[a-z0-9-]+\.upstash\.io/);
      expect(text, p).not.toMatch(/AX[A-Za-z0-9]{40,}/);
    }
  });
});
