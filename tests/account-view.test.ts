import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { accountStatusText, adminConfirmText, createBlocker, roleText } from "@/lib/account/admin-view";
import type { AuthConfig } from "@/lib/account/config";
import { createMemoryKv } from "@/lib/account/kv";
import { changeErrorText } from "@/lib/account/messages";
import { accountPageState } from "@/lib/account/page-state";
import type { AccountRecord, AccountSummary } from "@/lib/account/record";
import { createAccountStore } from "@/lib/account/store";
import { signSession } from "@/lib/account/token";

// アカウントの画面の文と状態（2026-09-24）。★値はすべて架空。
const SECRET = "kasou-secret-kasou-secret-kasou-secret-0123";
const NOW_MS = 1_800_000_000_000;
const summary = (over: Partial<AccountSummary> = {}): AccountSummary => ({
  id: "kasou-taro",
  name: "架空 太郎",
  role: "member",
  mustChange: false,
  tempExpiresAt: null,
  disabled: false,
  createdAt: NOW_MS,
  passwordChangedAt: null,
  ...over,
});

describe("管理の欄の文", () => {
  it("状態: 使える・仮のパスワード（期限つき）・期限切れ・止めている", () => {
    expect(accountStatusText(summary(), NOW_MS)).toEqual({ text: "使えます", tone: "ok" });
    expect(accountStatusText(summary({ mustChange: true, tempExpiresAt: NOW_MS + 86_400_000 }), NOW_MS).text).toContain(
      "本人がまだパスワードを決めていません",
    );
    expect(accountStatusText(summary({ mustChange: true, tempExpiresAt: NOW_MS - 1 }), NOW_MS).text).toContain("期限切れ");
    expect(accountStatusText(summary({ disabled: true, mustChange: true }), NOW_MS)).toEqual({ text: "止めています", tone: "off" });
    expect(roleText(summary({ role: "admin" }))).toBe("管理者");
  });

  it("★押す前の確認に、誰に何が起きるかを書く", () => {
    expect(adminConfirmText("reset", summary())).toContain("今のパスワードとログインは使えなくなります");
    expect(adminConfirmText("disable", summary())).toContain("5分以内にログインが切れ");
    expect(adminConfirmText("delete", summary())).toContain("元に戻せません");
    expect(adminConfirmText("delete", summary())).toContain("「架空 太郎」（kasou-taro）");
  });

  it("追加の欄の、押せない理由", () => {
    const base = { id: "kasou-hanako", name: "架空 花子", busy: false, existing: ["kasou-taro"] };
    expect(createBlocker(base)).toBeNull();
    expect(createBlocker({ ...base, id: "" })).toContain("ログインIDを入れて");
    expect(createBlocker({ ...base, id: "Kasou-Taro" })).toBe("そのログインIDはもう使われています");
    expect(createBlocker({ ...base, name: "" })).toContain("表示名を入れて");
    expect(createBlocker({ ...base, busy: true })).toBe("送っています");
  });
});

describe("パスワードを変えられなかったときの文", () => {
  it("理由の記号を文にする。知らない記号は出さない", () => {
    expect(changeErrorText("current", null)).toEqual(["今のパスワードが違います"]);
    expect(changeErrorText("policy", "short,mismatch")).toEqual([
      "パスワードは8文字以上にしてください",
      "確認のために入れたパスワードが一致しません",
    ]);
    expect(changeErrorText("policy", "<script>")).toEqual(["パスワードの決まりに合いませんでした"]);
    expect(changeErrorText("<x>", null)).toEqual([]);
    expect(changeErrorText(undefined, undefined)).toEqual([]);
  });
});

describe("/account の画面の状態", () => {
  const config: Extract<AuthConfig, { kind: "accounts" }> = {
    kind: "accounts",
    store: { kind: "file", path: "/dev/null" },
    secret: SECRET,
    legacy: null,
    bootstrap: null,
  };
  const record: AccountRecord = {
    v: 1,
    id: "kasou-taro",
    name: "架空 太郎",
    role: "member",
    hash: "scrypt$1$10.8.1$x$y",
    mustChange: false,
    tempExpiresAt: null,
    disabled: false,
    sv: 5,
    createdAt: 1,
    passwordChangedAt: null,
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const token = (sv = 5, mc: 0 | 1 = 0) => signSession({ u: "kasou-taro", sv, mc, chk: nowSec, exp: nowSec + 3600 }, SECRET);

  it("本人の今の状態を Redis で確かめる（版が違う・止めた・無いなら、入り直し）", async () => {
    const store = createAccountStore(createMemoryKv());
    await store.create(record);
    const of = () => store;
    expect(await accountPageState(config, token(), of, nowSec)).toMatchObject({ kind: "account", forced: false });
    expect(await accountPageState(config, token(5, 1), of, nowSec)).toMatchObject({ kind: "account", forced: true });
    expect(await accountPageState(config, token(6), of, nowSec)).toEqual({ kind: "expired" });
    expect(await accountPageState(config, undefined, of, nowSec)).toEqual({ kind: "expired" });
    expect(await accountPageState({ kind: "off" }, undefined, of, nowSec)).toEqual({ kind: "off" });
  });
});

describe("★画面の作り（中身を読んで見張る）", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

  it("パスワードの欄は、普通のフォームで /api/account/password へ送る（ブラウザの保存が効く）", () => {
    const form = read("components/account/password-form.tsx");
    expect(form).toContain('action="/api/account/password"');
    expect(form).toContain('method="post"');
    expect(form).toContain('autoComplete="new-password"');
    expect(form).not.toContain("fetch(");
  });

  it("管理の欄は /api/accounts だけを呼び、仮のパスワードを保存しない", () => {
    const admin = read("components/account/account-admin.tsx");
    expect(admin.match(/fetch\(([^,)]+)/g)).toEqual(['fetch("/api/accounts"']);
    expect(admin).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it("管理の欄は、管理者で、パスワードを決めたあとだけ出す", () => {
    expect(read("app/account/page.tsx")).toContain('state.record.role === "admin" && !state.forced && <AccountAdmin');
  });
});

describe("右上の人の形のアイコンのメニュー", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

  it("名前とログインID、アカウントへの入口（管理者は管理も）を出す", async () => {
    const { accountMenuView } = await import("@/lib/account/menu");
    const member = { legacy: false as const, id: "kasou-hanako", name: "架空 花子", admin: false, mustChange: false };
    expect(accountMenuView(member)).toEqual({
      label: "アカウント（架空 花子）",
      short: "架空 花子",
      heading: "架空 花子",
      sub: "ID: kasou-hanako",
      accountLink: "アカウント（パスワードを変える）",
    });
    expect(accountMenuView({ ...member, admin: true })).toMatchObject({
      sub: "ID: kasou-hanako・管理者",
      accountLink: "アカウント（パスワード・管理）",
    });
  });

  it("パスワードを決める前・前の合言葉のときは、アカウントへの入口を出さない（ログアウトだけ）", async () => {
    const { accountMenuView } = await import("@/lib/account/menu");
    expect(accountMenuView({ legacy: false, id: "kasou-x", name: "架空", admin: false, mustChange: true }).accountLink).toBeNull();
    const legacy = accountMenuView({ legacy: true });
    expect(legacy.accountLink).toBeNull();
    expect(legacy.short).toBe("前の合言葉");
    expect(legacy.sub).toContain("自分のログインIDで入り直してください");
  });

  it("★名前はいつもアイコンの横に出す（乗せたり押したりしなくても分かる）", () => {
    const menu = read("components/account-menu.tsx");
    const button = menu.slice(menu.indexOf('id="account-menu-button"'), menu.indexOf("</button>"));
    expect(button).toContain("{view.short}");
  });

  it("★アイコンは見出しと同じ段の右端に1つだけ。タブとボタンは見出しの1段下", () => {
    const layout = read("app/layout.tsx");
    expect(layout.split("<AccountMenu />").length - 1).toBe(1);
    // 見出し（</h1>）のすぐあとにアイコン、そのあとの段にタブ
    expect(layout.indexOf("<AccountMenu />")).toBeGreaterThan(layout.indexOf("</h1>"));
    expect(layout.indexOf("<ModeNav />")).toBeGreaterThan(layout.indexOf("<AccountMenu />"));
    expect(read("components/mode-nav.tsx")).not.toContain('action="/api/logout"');
  });
});
