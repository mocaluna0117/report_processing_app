import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearContactDraft,
  closeContact,
  getContactDraft,
  isContactOpen,
  isDraftEmpty,
  openContact,
  resetContactForTests,
  saveContactDraft,
  subscribeContact,
} from "@/lib/contact/dialog";
import { COMMON_FAQ } from "@/lib/help";

// 問い合わせのモーダル（2026-09-24）。画面のテスト基盤が無いので、開け閉め・下書きは lib で、
// 送るもの・読むものは中身を読んで見張る。

afterEach(() => resetContactForTests());

describe("開く・閉じる", () => {
  it("開くと知らせ、閉じると知らせる", () => {
    const seen: boolean[] = [];
    subscribeContact((open) => seen.push(open));
    openContact({ page: "/after" });
    closeContact();
    expect(seen).toEqual([true, false]);
    expect(isContactOpen()).toBe(false);
  });

  it("開いた画面を最初から選んでおく。選択肢に無い画面は「分からない」", () => {
    openContact({ page: "/tenmatsu" });
    expect(getContactDraft().page).toBe("/tenmatsu");
    closeContact();
    openContact({ page: "/login" });
    expect(getContactDraft().page).toBe("");
  });

  it("★書きかけがあるときは、別の画面から開いても選んだ画面を変えない", () => {
    openContact({ page: "/tenmatsu" });
    saveContactDraft({ ...getContactDraft(), message: "書きかけ" });
    closeContact();
    openContact({ page: "/" });
    expect(getContactDraft()).toMatchObject({ page: "/tenmatsu", message: "書きかけ" });
  });

  it("★打ったお名前は、開き直しても上書きしない", () => {
    openContact({ page: "/after", name: "架空 太郎" });
    saveContactDraft({ ...getContactDraft(), name: "架空 太郎（経理）" });
    closeContact();
    openContact({ page: "/", name: "架空 太郎" });
    expect(getContactDraft().name).toBe("架空 太郎（経理）");
  });

  it("ログインしている人の表示名を、お名前に最初から入れる（書きかけがあれば変えない）", () => {
    openContact({ page: "/after", name: "架空 太郎" });
    expect(getContactDraft().name).toBe("架空 太郎");
    saveContactDraft({ ...getContactDraft(), message: "書きかけ", name: "" });
    closeContact();
    openContact({ page: "/", name: "架空 太郎" });
    expect(getContactDraft()).toMatchObject({ name: "", message: "書きかけ" });
  });

  it("送れたら下書きを消す（選んだ画面は残す）", () => {
    openContact({ page: "/after" });
    saveContactDraft({ ...getContactDraft(), message: "内容", name: "架空　花子", category: "idea" });
    clearContactDraft();
    expect(isDraftEmpty(getContactDraft())).toBe(true);
    expect(getContactDraft()).toMatchObject({ page: "/after", category: "bug", photosChecked: false });
  });
});

describe("★送るもの・読むもの（中身を読んで見張る）", () => {
  const source = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");
  const dialog = source("components/contact-dialog.tsx");

  it("楽楽精算のログインID・共有フォルダーの名前・取得のログを読まない", () => {
    expect(dialog).not.toContain("getLoginUserId");
    expect(dialog).not.toContain("folderName");
    expect(dialog).not.toContain("run-log");
    expect(dialog).not.toContain("getPassword");
  });

  it("送り先は /api/contact だけ。送るのは送信の処理の中だけ", () => {
    const fetches = dialog.match(/fetch\(([^,)]+)/g) ?? [];
    expect(fetches).toEqual(['fetch("/api/contact"']);
    for (const block of dialog.split("useEffect(").slice(1)) {
      expect(block.slice(0, block.indexOf("}, ["))).not.toContain("fetch(");
    }
  });

  it("下書きをブラウザに保存しない（メモリだけ）", () => {
    for (const path of ["components/contact-dialog.tsx", "lib/contact/dialog.ts"]) {
      const text = source(path).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(text, path).not.toMatch(/sessionStorage|localStorage|indexedDB/);
    }
  });

  it("ヘッダーに1つだけ載せ、使い方の小窓からも開ける", () => {
    const nav = source("components/mode-nav.tsx");
    expect(nav.split("<ContactDialog />").length - 1).toBe(1);
    expect(nav).toContain("openContact({ page: pathname, name:");
    expect(source("components/help-dialog.tsx")).toContain("openContact(");
  });
});

describe("使い方", () => {
  it("どの画面でも、に問い合わせの案内がある（書かないでほしいことも）", () => {
    const item = COMMON_FAQ.find((f) => f.q.includes("不具合を見つけたとき"));
    expect(item?.a).toContain("問い合わせ");
    expect(item?.a).toContain("お客様の氏名・住所・電話番号は書かないでください");
    expect(item?.a).toContain("楽楽精算のログインIDは送りません");
    expect(item?.a).toContain("Folio のアカウントの名前も入ります");
  });
});
