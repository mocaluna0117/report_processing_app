import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContactPayload } from "@/lib/contact/form";
import { type ContactDeps, DEFAULT_CONTACT_FROM, handleContact } from "@/lib/contact/handle";
import { createRateLimiter } from "@/lib/contact/rate-limit";
import { type ContactMail, classifyResendError } from "@/lib/contact/send";

// 問い合わせを受け取って送る（2026-09-24）。
// ★守ること: 中身は検査してから送る／写真は先頭のバイトで確かめ、元のファイル名は使わない／
//   設定が無いときは送らずに知らせる／失敗の文にアドレスを出さない／ログに中身を書かない。

const ENV = { apiKey: "re_test", to: "dev@example.com", commit: "abc1234def", environment: "production" };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const payload = (over: Partial<ContactPayload> = {}): ContactPayload => ({
  category: "idea",
  page: "/after",
  message: "受付一覧に「完了」で絞り込む欄がほしいです。",
  name: "架空　花子",
  diagnostics: { browser: "Chrome 140・Windows", viewport: "1920×1080", rakuraku: "未ログイン", shared: "connected" },
  ...over,
});

function form(p: unknown = payload(), photos: { bytes: Uint8Array<ArrayBuffer>; name: string }[] = []): FormData {
  const data = new FormData();
  data.set("payload", typeof p === "string" ? p : JSON.stringify(p));
  for (const photo of photos) data.append("photo", new File([new Uint8Array(photo.bytes)], photo.name));
  return data;
}

function deps(over: Partial<ContactDeps> = {}) {
  const sent: ContactMail[] = [];
  const d: ContactDeps = {
    send: vi.fn(async (mail: ContactMail) => {
      sent.push(mail);
      return { ok: true as const };
    }),
    limiter: createRateLimiter({ windowMs: 60_000, max: 5 }),
    now: () => 1_700_000_000_000,
    ...over,
  };
  return { d, sent };
}

describe("送る", () => {
  it("件名・本文・宛先・送り元を組み立てて送る", async () => {
    const { d, sent } = deps();
    const result = await handleContact(form(), ENV, d);
    expect(result).toEqual({ status: 200, body: { ok: true, code: "OK", message: "送りました。ありがとうございます" } });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("dev@example.com");
    expect(sent[0].from).toBe(DEFAULT_CONTACT_FROM);
    expect(sent[0].subject).toBe("[Folio] 改善の要望: アフターメンテナンス — 受付一覧に「完了」で絞り込む欄がほしいです。");
    expect(sent[0].text).toContain("Folio の版: abc1234 (production)");
    expect(sent[0].text).toContain("お名前: 架空　花子");
  });

  it("送り元は CONTACT_FROM で変えられる", async () => {
    const { d, sent } = deps();
    await handleContact(form(), { ...ENV, from: "Folio <folio@example.com>" }, d);
    expect(sent[0].from).toBe("Folio <folio@example.com>");
  });

  it("★写真は種類を確かめ、元のファイル名は使わない（お客様の氏名が入っていることがある）", async () => {
    const { d, sent } = deps();
    const result = await handleContact(form(payload(), [{ bytes: PNG, name: "山田　太郎様邸.png" }]), ENV, d);
    expect(result.status).toBe(200);
    expect(sent[0].attachments.map((a) => a.filename)).toEqual(["写真1.png"]);
    expect(sent[0].text).toContain("写真: 1枚");
  });
});

describe("送らないとき", () => {
  it("★設定（鍵か宛先）が無ければ送らずに知らせる", async () => {
    for (const env of [{ ...ENV, apiKey: "" }, { ...ENV, to: undefined }, { ...ENV, to: "not-an-address" }]) {
      const { d, sent } = deps();
      const result = await handleContact(form(), env, d);
      expect(result.status).toBe(503);
      expect(result.body.code).toBe("NOT_CONFIGURED");
      expect(result.body.message).toContain("文面をコピー");
      expect(sent).toHaveLength(0);
    }
  });

  it("中身が読めない・検査に通らなければ送らない", async () => {
    for (const bad of ["{not json", payload({ message: "" }), payload({ category: "x" as never })]) {
      const { d, sent } = deps();
      const result = await handleContact(form(bad), ENV, d);
      expect(result.status).toBe(400);
      expect(sent).toHaveLength(0);
    }
  });

  it("★写真でないもの（拡張子だけ png）は送らない", async () => {
    const { d, sent } = deps();
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    const result = await handleContact(form(payload(), [{ bytes: svg, name: "a.png" }]), ENV, d);
    expect(result.status).toBe(400);
    expect(result.body.message).toContain("PNG・JPEG・WebP");
    expect(sent).toHaveLength(0);
  });

  it("写真の枚数・大きさの上限", async () => {
    const { d } = deps();
    const four = Array.from({ length: 4 }, (_, i) => ({ bytes: PNG, name: `${i}.png` }));
    expect((await handleContact(form(payload(), four), ENV, d)).status).toBe(400);
    const big = new Uint8Array(1_500_001);
    big.set(PNG);
    expect((await handleContact(form(payload(), [{ bytes: big, name: "big.png" }]), ENV, d)).status).toBe(413);
  });

  it("続けて送られたら止める（押し間違いの連打・いたずら）", async () => {
    const { d, sent } = deps({ limiter: createRateLimiter({ windowMs: 60_000, max: 2 }) });
    await handleContact(form(), ENV, d);
    await handleContact(form(), ENV, d);
    const third = await handleContact(form(), ENV, d);
    expect(third.status).toBe(429);
    expect(third.body.message).toContain("待ってから");
    expect(sent).toHaveLength(2);
  });
});

describe("送れなかったとき", () => {
  it("種類ごとの文にする。★Resend の文（宛先が入ることがある）はそのまま出さない", async () => {
    const cases = [
      ["config", "送信の設定"],
      ["quota", "1日100通まで"],
      ["rate", "少し待って"],
      ["timeout", "届いていることもあります"],
      ["other", "文面をコピー"],
    ] as const;
    for (const [failure, text] of cases) {
      const { d } = deps({ send: async () => ({ ok: false, failure }) });
      const result = await handleContact(form(), ENV, d);
      expect(result.status).toBe(502);
      expect(result.body.message).toContain(text);
      expect(result.body.message).not.toContain("@");
    }
  });

  it("Resend のエラーの見分け方", () => {
    // ★独自ドメインが無いと「自分のメール宛てにしか送れません」が 403 で返る
    expect(classifyResendError({ name: "validation_error", statusCode: 403 })).toBe("config");
    expect(classifyResendError({ name: "invalid_api_key", statusCode: 401 })).toBe("config");
    expect(classifyResendError({ name: "daily_quota_exceeded", statusCode: 429 })).toBe("quota");
    expect(classifyResendError({ name: "rate_limit_exceeded", statusCode: 429 })).toBe("rate");
    expect(classifyResendError({ name: "internal_server_error", statusCode: 500 })).toBe("other");
  });
});

describe("★ログに中身を書かない（中身を読んで見張る）", () => {
  const source = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");

  it("受け取り・送信の部品では console を使わない。口は種類だけを書く", () => {
    expect(source("lib/contact/handle.ts")).not.toContain("console.");
    expect(source("lib/contact/send.ts")).not.toContain("console.");
    const route = source("app/api/contact/route.ts");
    const calls = route.match(/console\.[a-z]+\([^)]*\)/g) ?? [];
    expect(calls).toEqual(["console.error(`[contact] ${result.body.code}`)"]);
  });

  it("口は、別のサイトからの送信を断る", () => {
    expect(source("app/api/contact/route.ts")).toContain("assertSameOrigin(request)");
  });
});
