import { afterEach, describe, expect, it, vi } from "vitest";
import { GuardError, assertEnabled, assertSameOrigin } from "@/lib/rakuraku/guard";
import { log, redactUrl } from "@/lib/rakuraku/log";

const KEYS = [
  "RAKURAKU_LOGIN_URL",
  "RAKURAKU_ALLOW_PREVIEW",
  "VERCEL_ENV",
  "VERCEL",
  "APP_PASSWORD",
  "FOLIO_SESSION_SECRET",
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
  "FOLIO_ACCOUNTS",
] as const;
/** 本番で Folio のログイン（一人ずつのアカウント）がそろっている（★値は架空） */
const ACCOUNTS = {
  FOLIO_SESSION_SECRET: "kasou-secret-kasou-secret-kasou-secret-0123",
  KV_REST_API_URL: "https://kasou.upstash.invalid",
  KV_REST_API_TOKEN: "kasou-token",
};
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

function setup(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
}

const OK_URL = "https://example.test/abcd/";

describe("ルートの門番", () => {
  it("設定が無ければ止める", () => {
    setup({});
    expect(() => assertEnabled()).toThrow(GuardError);
    try {
      assertEnabled();
    } catch (e) {
      expect((e as GuardError).code).toBe("DISABLED");
    }
  });

  it("★本番で Folio のログインが無ければ止める (ログイン試行の踏み台にさせない)", () => {
    // ★旧合言葉だけでは足りない（アカウントの設定が要る）
    setup({ RAKURAKU_LOGIN_URL: OK_URL, VERCEL_ENV: "production", APP_PASSWORD: "x" });
    try {
      assertEnabled();
      throw new Error("通ってはいけない");
    } catch (e) {
      expect((e as GuardError).code).toBe("NO_PASSWORD");
    }
  });

  it("本番で Folio のログインがあれば通す", () => {
    setup({ RAKURAKU_LOGIN_URL: OK_URL, VERCEL_ENV: "production", ...ACCOUNTS });
    expect(assertEnabled().loginUrl).toBe(OK_URL);
  });

  it("★プレビューは既定で止める (URLが毎回変わるので本番の楽楽精算を触らせない)", () => {
    setup({ RAKURAKU_LOGIN_URL: OK_URL, VERCEL_ENV: "preview" });
    try {
      assertEnabled();
      throw new Error("通ってはいけない");
    } catch (e) {
      expect((e as GuardError).code).toBe("PREVIEW_BLOCKED");
    }
  });

  it("プレビューでも明示的に許せば通る", () => {
    setup({ RAKURAKU_LOGIN_URL: OK_URL, VERCEL_ENV: "preview", RAKURAKU_ALLOW_PREVIEW: "1" });
    expect(assertEnabled().loginUrl).toBe(OK_URL);
  });

  it("手元 (VERCEL_ENV なし) はそのまま通る", () => {
    setup({ RAKURAKU_LOGIN_URL: OK_URL });
    expect(assertEnabled().loginUrl).toBe(OK_URL);
  });
});

describe("別サイトからの呼び出しを弾く", () => {
  const req = (headers: Record<string, string>) =>
    new Request("https://folio.test/api/rakuraku/probe", { headers });

  it("同じサイトからは通す", () => {
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "same-origin" }))).not.toThrow();
  });

  it("アドレス欄から直接開いた場合 (none) も通す", () => {
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "none" }))).not.toThrow();
  });

  it("★別サイトからは拒む", () => {
    expect(() => assertSameOrigin(req({ "sec-fetch-site": "cross-site" }))).toThrow("別のサイト");
  });

  it("★Origin が違えば拒む", () => {
    expect(() => assertSameOrigin(req({ origin: "https://evil.test" }))).toThrow("別のサイト");
  });

  it("ヘッダーが無い呼び出し (curl 等) は通す", () => {
    expect(() => assertSameOrigin(req({}))).not.toThrow();
  });
});

describe("記録に個人情報を混ぜない", () => {
  it("段階名・符号・数値だけを出す", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    log("launch", { ok: true, code: "OK", ms_launch: 1200, n_frames: 3 });
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({
      stage: "launch",
      ok: true,
      code: "OK",
      ms_launch: 1200,
      n_frames: 3,
    });
  });

  it("★決まった形でないキーは黙って捨てる", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    // 型では防いでいるが、実行時にも通さない
    log("detail", { denpyoNo: "TE00001476", 施主名: "架空 太郎" } as never);
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({ stage: "detail" });
  });

  it("URL はクエリを落として残す (伝票No.が入るため)", () => {
    expect(redactUrl("https://example.test/abcd/detail?eDenpyoNo=TE00001476")).toBe(
      "https://example.test/abcd/detail",
    );
  });

  it("壊れたURLでも落ちない", () => {
    expect(redactUrl("これはURLではない")).toBe("(不正なURL)");
  });
});
