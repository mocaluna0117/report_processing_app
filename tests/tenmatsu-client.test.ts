import { describe, expect, it } from "vitest";
import {
  createTenmatsuClient,
  describeCompletion,
  describeFailure,
  formatFetchedAt,
  formatFileSize,
  isFinished,
  isListItemLike,
  isValidToken,
  NETWORK_FAILURE_MESSAGE,
  type StatusPayload,
  TENMATSU_BASE_URL,
  TenmatsuError,
} from "@/lib/tenmatsu/client";

/** 呼ばれたURLとヘッダーを覚える偽の fetch (グローバルには触らない) */
function fakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const status = (over: Partial<StatusPayload> = {}): StatusPayload => ({
  state: "running",
  done: 3,
  total: 10,
  current: "TE00001469",
  message: "顛末書No.1469.pdf を保存しました",
  error: null,
  error_file: null,
  processed: 0,
  remaining: 0,
  saved: [],
  ...over,
});

const headerOf = (init: RequestInit, name: string) =>
  (init.headers as Record<string, string> | undefined)?.[name];

/** 失敗を TenmatsuError として受け取る (成功してしまったらテストを落とす) */
async function failureOf(call: () => Promise<unknown>): Promise<TenmatsuError> {
  try {
    await call();
  } catch (e) {
    if (e instanceof TenmatsuError) return e;
    throw e;
  }
  throw new Error("失敗するはずの呼び出しが成功しました");
}

describe("リクエストの組み立て", () => {
  it("一覧はトークンをヘッダーで送り、毎回取りに行く", async () => {
    const { impl, calls } = fakeFetch(() => json({ items: [] }));
    await createTenmatsuClient({ token: "tok-1", fetchImpl: impl }).list();
    expect(calls[0].url.href).toBe(`${TENMATSU_BASE_URL}/list`);
    expect(headerOf(calls[0].init, "X-Tenmatsu-Token")).toBe("tok-1");
    expect(calls[0].init.cache).toBe("no-store");
    expect(calls[0].init.credentials).toBe("omit");
  });

  it("疎通確認はトークンを送らない (単純なGETに保つため)", async () => {
    const { impl, calls } = fakeFetch(() => json({ ok: true, job_state: "idle" }));
    await createTenmatsuClient({ token: "tok-1", fetchImpl: impl }).health();
    expect(calls[0].url.pathname).toBe("/health");
    expect(headerOf(calls[0].init, "X-Tenmatsu-Token")).toBeUndefined();
  });

  it("PDFの取得でトークンをクエリに載せない", async () => {
    const { impl, calls } = fakeFetch(() => new Response("%PDF-1.4", { status: 200 }));
    const blob = await createTenmatsuClient({ token: "tok-1", fetchImpl: impl }).filePdf(
      "TE00001469",
    );
    expect(calls[0].url.pathname).toBe("/file");
    expect(calls[0].url.searchParams.get("no")).toBe("TE00001469");
    expect(calls[0].url.search).not.toContain("tok-1");
    expect(headerOf(calls[0].init, "X-Tenmatsu-Token")).toBe("tok-1");
    expect(await blob.text()).toBe("%PDF-1.4");
  });

  it("伝票No.に記号が入っていてもURLを壊さない", async () => {
    const { impl, calls } = fakeFetch(() => new Response("x", { status: 200 }));
    await createTenmatsuClient({ token: "t", fetchImpl: impl }).filePdf("TE 1/2");
    expect(calls[0].url.searchParams.get("no")).toBe("TE 1/2");
    expect(calls[0].url.pathname).toBe("/file");
  });

  it("一覧の中で形の合わない行は捨てる", async () => {
    const good = {
      denpyo_no: "TE00009001",
      file: "顛末書No.9001.pdf",
      at: "2026-09-04T10:00:00",
      exists: true,
      pages: 3,
      size: 29140,
    };
    const { impl } = fakeFetch(() => json({ items: [good, { denpyo_no: 1 }, "なにか"] }));
    const items = await createTenmatsuClient({ token: "t", fetchImpl: impl }).list();
    expect(items).toEqual([good]);
  });

  it("items が無い応答でも空配列を返す", async () => {
    const { impl } = fakeFetch(() => json({}));
    expect(await createTenmatsuClient({ token: "t", fetchImpl: impl }).list()).toEqual([]);
  });
});

describe("失敗の扱い", () => {
  it("401 はトークンの登録し直しを促す", async () => {
    const { impl } = fakeFetch(() => json({ error: "トークンが違います" }, 401));
    const client = createTenmatsuClient({ token: "bad", fetchImpl: impl });
    await expect(client.status()).rejects.toThrow(TenmatsuError);
    const e = await failureOf(() => client.status());
    expect(e.kind).toBe("auth");
    expect(e.status).toBe(401);
    expect(e.message).toContain("トークン");
    expect(e.message).toContain("登録し直して");
  });

  it("401 で本文が空でも同じ案内になる", async () => {
    const { impl } = fakeFetch(() => new Response("", { status: 401 }));
    const e = await failureOf(() => createTenmatsuClient({ token: "bad", fetchImpl: impl }).status());
    expect(e.kind).toBe("auth");
    expect(e.message).toContain("登録し直して");
  });

  it("404 はサーバーの文言をそのまま使う", async () => {
    const { impl } = fakeFetch(() => json({ error: "伝票 TE00000001 の記録がありません" }, 404));
    const e = await failureOf(() => createTenmatsuClient({ token: "t", fetchImpl: impl }).filePdf("TE00000001"));
    expect(e.kind).toBe("notFound");
    expect(e.message).toBe("伝票 TE00000001 の記録がありません");
  });

  it("500 はサーバーの文言を添える", async () => {
    const { impl } = fakeFetch(() => json({ error: "一覧を作れませんでした: boom" }, 500));
    const e = await failureOf(() => createTenmatsuClient({ token: "t", fetchImpl: impl }).list());
    expect(e.kind).toBe("server");
    expect(e.message).toContain("一覧を作れませんでした");
  });

  it("JSONでない応答でも日本語の案内になる", async () => {
    const { impl } = fakeFetch(() => new Response("<html>", { status: 502 }));
    const e = await failureOf(() => createTenmatsuClient({ token: "t", fetchImpl: impl }).list());
    expect(e.kind).toBe("server");
    expect(e.message).toContain("502");
  });

  it("通信そのものの失敗は3つの原因すべてに触れる (どれかに決めつけない)", async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const e = await failureOf(() => createTenmatsuClient({ token: "t", fetchImpl: impl }).health());
    expect(e.kind).toBe("network");
    expect(e.status).toBeNull();
    expect(e.message).toContain("起動");
    expect(e.message).toContain("許可");
    expect(e.message).toContain("allowed_origins");
    expect(e.message).toBe(NETWORK_FAILURE_MESSAGE);
  });

  it("時間切れは通信失敗と別の案内にする", async () => {
    const { impl } = fakeFetch(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const e = await failureOf(() => createTenmatsuClient({ token: "t", fetchImpl: impl }).status());
    expect(e.kind).toBe("timeout");
    expect(e.message).toContain("時間内に応答しませんでした");
    expect(e.message).not.toBe(NETWORK_FAILURE_MESSAGE);
  });

  it("describeFailure の対応表", () => {
    expect(describeFailure(400).kind).toBe("badRequest");
    expect(describeFailure(403).kind).toBe("forbidden");
    expect(describeFailure(403).message).toContain("allowed_origins");
    expect(describeFailure(418).kind).toBe("unknown");
    expect(describeFailure(418).message).toContain("418");
    // サーバーの文言があれば優先する
    expect(describeFailure(400, "伝票No.が指定されていません").message).toBe(
      "伝票No.が指定されていません",
    );
    // 空文字は文言なし扱いにする
    expect(describeFailure(404, "  ").message).toBe("見つかりませんでした");
  });
});

describe("実行の開始", () => {
  it("200 なら started:true と最初の進捗を返す", async () => {
    const { impl, calls } = fakeFetch(() => json({ ok: true, status: status() }));
    const res = await createTenmatsuClient({ token: "t", fetchImpl: impl }).run();
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/run");
    expect(res.started).toBe(true);
    expect(res.status.state).toBe("running");
  });

  it("409 (すでに実行中) はエラーにせず、進行中の進捗を返す", async () => {
    const { impl } = fakeFetch(() =>
      json({ error: "すでに実行中です", status: status({ remaining: 86 }) }, 409),
    );
    const res = await createTenmatsuClient({ token: "t", fetchImpl: impl }).run();
    expect(res.started).toBe(false);
    expect(res.status.remaining).toBe(86);
  });

  it("開始直後に失敗して done/error で返っても例外にしない", async () => {
    const { impl } = fakeFetch(() =>
      json({ ok: true, status: status({ state: "error", error: "楽楽精算に入れません" }) }),
    );
    const res = await createTenmatsuClient({ token: "t", fetchImpl: impl }).run();
    expect(res.started).toBe(true);
    expect(isFinished(res.status.state)).toBe(true);
  });

  it("status が入っていない応答は例外にする", async () => {
    const { impl } = fakeFetch(() => json({ ok: true }));
    const e = await failureOf(() => createTenmatsuClient({ token: "t", fetchImpl: impl }).run());
    expect(e).toBeInstanceOf(TenmatsuError);
    expect(e.message).toContain("確認できませんでした");
  });

  it("401 は実行でも例外にする", async () => {
    const { impl } = fakeFetch(() => json({ error: "トークンが違います" }, 401));
    const e = await failureOf(() => createTenmatsuClient({ token: "bad", fetchImpl: impl }).run());
    expect(e.kind).toBe("auth");
  });
});

describe("isFinished", () => {
  it("done と error で止める", () => {
    expect(isFinished("idle")).toBe(false);
    expect(isFinished("running")).toBe(false);
    expect(isFinished("done")).toBe(true);
    expect(isFinished("error")).toBe(true);
  });
});

describe("describeCompletion", () => {
  it("見送った分があれば必ず伝える", () => {
    const c = describeCompletion(status({ state: "done", processed: 10, remaining: 86 }));
    expect(c?.tone).toBe("notice");
    expect(c?.message).toContain("10件を保存しました");
    expect(c?.message).toContain("残り86件は次回実行してください");
  });

  it("残りが無ければそのまま", () => {
    const c = describeCompletion(status({ state: "done", processed: 3, remaining: 0 }));
    expect(c?.tone).toBe("ok");
    expect(c?.message).toBe("3件を保存しました");
    expect(c?.message).not.toContain("残り");
  });

  it("0件でも「無かった」と分かるように出す", () => {
    const c = describeCompletion(status({ state: "done", processed: 0, total: 0, done: 0 }));
    expect(c?.tone).toBe("ok");
    expect(c?.message).toBe("新しく取得できる顛末書はありませんでした");
  });

  it("失敗は理由とログの場所を出す", () => {
    const c = describeCompletion(
      status({
        state: "error",
        error: "TimeoutError: 一覧が開きません",
        error_file: "C:\\Users\\x\\顛末書\\log.txt",
      }),
    );
    expect(c?.tone).toBe("error");
    expect(c?.message).toContain("TimeoutError");
    expect(c?.message).toContain("log.txt");
  });

  it("理由が空でも落ちない", () => {
    const c = describeCompletion(status({ state: "error", error: null, error_file: null }));
    expect(c?.tone).toBe("error");
    expect(c?.message).toContain("原因不明");
  });

  it("実行中・未実行では何も出さない", () => {
    expect(describeCompletion(status({ state: "running" }))).toBeNull();
    expect(describeCompletion(status({ state: "idle" }))).toBeNull();
  });
});

describe("トークンの検証", () => {
  it("ASCIIの印字文字だけを通す", () => {
    expect(isValidToken("aB9-_x")).toBe(true);
    expect(isValidToken("Zm9vYmFy_-abc123")).toBe(true);
    expect(isValidToken("")).toBe(false);
    expect(isValidToken("とーくん")).toBe(false);
    expect(isValidToken("abc def")).toBe(false);
    expect(isValidToken("abc\n")).toBe(false);
    expect(isValidToken("abc\t")).toBe(false);
  });
});

describe("表示用の整形", () => {
  it("取得日時", () => {
    expect(formatFetchedAt("2026-09-04T10:00:00")).toBe("2026/9/4 10:00");
    expect(formatFetchedAt("2026-12-31T23:59:59")).toBe("2026/12/31 23:59");
    expect(formatFetchedAt(null)).toBe("－");
    expect(formatFetchedAt("なにか")).toBe("－");
  });

  it("ファイルの大きさ", () => {
    expect(formatFileSize(512)).toBe("512B");
    expect(formatFileSize(29140)).toBe("28KB");
    expect(formatFileSize(3_500_000)).toBe("3.3MB");
    expect(formatFileSize(null)).toBe("－");
  });

  it("isListItemLike", () => {
    const good = {
      denpyo_no: "TE1",
      file: "f.pdf",
      at: null,
      exists: false,
      pages: null,
      size: null,
    };
    expect(isListItemLike(good)).toBe(true);
    expect(isListItemLike({ ...good, exists: "true" })).toBe(false);
    expect(isListItemLike({ ...good, at: 20260904 })).toBe(false);
    expect(isListItemLike(null)).toBe(false);
    expect(isListItemLike("なにか")).toBe(false);
  });
});
