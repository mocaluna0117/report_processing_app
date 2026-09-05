import { describe, expect, it } from "vitest";
import {
  createTenmatsuClient,
  describeCompletion,
  describeFailure,
  EMPTY_FLAGS_MESSAGE,
  formatFetchedAt,
  formatFileSize,
  hasFlags,
  type HealthPayload,
  isFinished,
  isListItemLike,
  isValidToken,
  type ListItem,
  NETWORK_FAILURE_MESSAGE,
  resolveRunLimits,
  RUN_COUNT_FORMAT_MESSAGE,
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

const listItem = (over: Partial<ListItem> = {}): ListItem => ({
  denpyo_no: "TE00009001",
  file: "顛末書No.9001.pdf",
  at: "2026-09-04T10:00:00",
  exists: true,
  pages: 3,
  size: 29140,
  budget_entered: false,
  cloud_stored: false,
  completed: false,
  flags_updated_at: null,
  ...over,
});

/** 完了フラグに未対応のサーバー・この機能より前のキャッシュが返す形 (6項目だけ) */
const oldShapeItem = {
  denpyo_no: "TE00009002",
  file: "顛末書No.9002.pdf",
  at: "2026-09-04T10:00:00",
  exists: true,
  pages: 3,
  size: 29140,
};

const health = (over: Partial<HealthPayload> = {}): HealthPayload => ({
  ok: true,
  service: "tenmatsu-local",
  version: 1,
  save_dir: "C:\\Users\\x\\顛末書",
  job_state: "idle",
  max_per_run: 10,
  max_per_run_min: 1,
  max_per_run_max: 100,
  headless: true,
  demo: false,
  ...over,
});

/** 更新していないPCのサーバー (5個しか返さない) */
const oldHealth = {
  ok: true,
  service: "tenmatsu-local",
  version: 1,
  save_dir: "",
  job_state: "idle",
} as HealthPayload;

const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;

describe("リクエストの組み立て", () => {
  it("一覧はトークンをヘッダーで送り、毎回取りに行く", async () => {
    const { impl, calls } = fakeFetch(() => json({ items: [] }));
    await createTenmatsuClient({ token: "tok-1", fetchImpl: impl }).list();
    expect(calls[0].url.href).toBe(`${TENMATSU_BASE_URL}/list`);
    expect(headerOf(calls[0].init, "X-Tenmatsu-Token")).toBe("tok-1");
    expect(calls[0].init.cache).toBe("no-store");
    expect(calls[0].init.credentials).toBe("omit");
  });

  it("本文があるときだけ Content-Type を付ける", async () => {
    const listCalls = fakeFetch(() => json({ items: [] }));
    await createTenmatsuClient({ token: "t", fetchImpl: listCalls.impl }).list();
    expect(headerOf(listCalls.calls[0].init, "Content-Type")).toBeUndefined();
    expect(listCalls.calls[0].init.body).toBeUndefined();

    const runCalls = fakeFetch(() => json({ ok: true, status: status() }));
    await createTenmatsuClient({ token: "t", fetchImpl: runCalls.impl }).run({ maxPerRun: 5 });
    expect(headerOf(runCalls.calls[0].init, "Content-Type")).toBe("application/json");
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
    // /run と /flags でも 400 になるので、/file 専用の文言を既定にしない
    expect(describeFailure(400).message).not.toContain("伝票No.");
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

  it("件数をJSONの本文で送る", async () => {
    const { impl, calls } = fakeFetch(() =>
      json({ ok: true, max_per_run: 25, headless: true, status: status() }),
    );
    const res = await createTenmatsuClient({ token: "t", fetchImpl: impl }).run({ maxPerRun: 25 });
    expect(bodyOf(calls[0].init)).toEqual({ max_per_run: 25 });
    expect(res.maxPerRun).toBe(25);
    expect(res.headless).toBe(true);
  });

  it("件数を省略したら空のオブジェクトを送る (サーバーの既定値で動かす)", async () => {
    const { impl, calls } = fakeFetch(() => json({ ok: true, status: status() }));
    const res = await createTenmatsuClient({ token: "t", fetchImpl: impl }).run();
    expect(calls[0].init.body).toBe("{}");
    expect(res.started).toBe(true);
  });

  it("指定していないキーは送らない (null を送るとサーバーは未指定と同じに扱う)", async () => {
    const { impl, calls } = fakeFetch(() => json({ ok: true, status: status() }));
    const client = createTenmatsuClient({ token: "t", fetchImpl: impl });
    await client.run({ maxPerRun: 5 });
    expect("headless" in bodyOf(calls[0].init)).toBe(false);
    await client.run({ headless: false });
    expect(Object.keys(bodyOf(calls[1].init))).toEqual(["headless"]);
  });

  it("件数を返さない古いサーバーでは maxPerRun が null になる", async () => {
    const { impl } = fakeFetch(() => json({ ok: true, status: status() }));
    const res = await createTenmatsuClient({ token: "t", fetchImpl: impl }).run({ maxPerRun: 50 });
    expect(res.started).toBe(true);
    expect(res.maxPerRun).toBeNull();
    expect(res.headless).toBeNull();
  });

  it("整数でない件数は通信する前に弾く", async () => {
    for (const value of [1.5, Number.NaN]) {
      const { impl, calls } = fakeFetch(() => json({ ok: true, status: status() }));
      const e = await failureOf(() =>
        createTenmatsuClient({ token: "t", fetchImpl: impl }).run({ maxPerRun: value }),
      );
      expect(e.message).toBe(RUN_COUNT_FORMAT_MESSAGE);
      expect(e.kind).toBe("badRequest");
      expect(e.status).toBeNull();
      // NaN は JSON.stringify で null になり、サーバーは「未指定」と読んで既定値で走ってしまう
      expect(calls.length).toBe(0);
    }
  });

  it("範囲外の件数はサーバーの文言をそのまま出す", async () => {
    const message = "max_per_run は 1〜100 の範囲で指定してください（受け取った値: 0）";
    const { impl } = fakeFetch(() => json({ error: message }, 400));
    const e = await failureOf(() =>
      createTenmatsuClient({ token: "t", fetchImpl: impl }).run({ maxPerRun: 0 }),
    );
    expect(e.kind).toBe("badRequest");
    expect(e.status).toBe(400);
    expect(e.message).toBe(message);
  });

  it("整数でないと言われた400の文言も加工しない (値はPythonの表記で入る)", async () => {
    const message = "max_per_run は整数で指定してください（受け取った値: True）";
    const { impl } = fakeFetch(() => json({ error: message }, 400));
    const e = await failureOf(() => createTenmatsuClient({ token: "t", fetchImpl: impl }).run());
    expect(e.message).toBe(message);
  });

  it("409 (すでに実行中) はエラーにせず、進行中の進捗を返す", async () => {
    const { impl } = fakeFetch(() =>
      json({ error: "すでに実行中です", status: status({ remaining: 86 }) }, 409),
    );
    const res = await createTenmatsuClient({ token: "t", fetchImpl: impl }).run({ maxPerRun: 5 });
    expect(res.started).toBe(false);
    expect(res.status.remaining).toBe(86);
    // 合流しただけなので、指定した件数は効いていない
    expect(res.maxPerRun).toBeNull();
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

describe("完了フラグを持つ一覧", () => {
  it("フラグ4つをそのまま通す (completed を計算し直さない)", async () => {
    // 両方 true なのに completed が false で届いても、そのまま渡すのが正しい
    const row = listItem({
      budget_entered: true,
      cloud_stored: true,
      completed: false,
      flags_updated_at: "2026-09-04T18:20:00",
    });
    const { impl } = fakeFetch(() => json({ items: [row] }));
    expect(await createTenmatsuClient({ token: "t", fetchImpl: impl }).list()).toEqual([row]);
  });

  it("フラグを持たない古い形の行も落とさない (0件に見せてはいけない)", async () => {
    const { impl } = fakeFetch(() => json({ items: [oldShapeItem, listItem()] }));
    const items = await createTenmatsuClient({ token: "t", fetchImpl: impl }).list();
    expect(items.map((i) => i.denpyo_no)).toEqual(["TE00009002", "TE00009001"]);
  });

  it("hasFlags でフラグが分かる行と分からない行を見分ける", () => {
    expect(hasFlags(listItem())).toBe(true);
    expect(hasFlags(listItem({ budget_entered: true, cloud_stored: true }))).toBe(true);
    expect(hasFlags(oldShapeItem as ListItem)).toBe(false);
  });

  it("isListItemLike は6項目だけの行も通す (キャッシュを捨てないため)", () => {
    expect(isListItemLike(oldShapeItem)).toBe(true);
    expect(isListItemLike(listItem())).toBe(true);
    // 入っているときは型を確かめる
    expect(isListItemLike({ ...oldShapeItem, budget_entered: 1 })).toBe(false);
    expect(isListItemLike({ ...oldShapeItem, completed: "yes" })).toBe(false);
    expect(isListItemLike({ ...oldShapeItem, flags_updated_at: 20260904 })).toBe(false);
    expect(isListItemLike({ ...oldShapeItem, flags_updated_at: null })).toBe(true);
  });
});

describe("楽楽精算の一覧から読んだ項目", () => {
  const filled = {
    shinsei_date: "2026/09/01",
    shinseisha: "テスト 太郎",
    amount: "71,500 円",
    payee: "テスト商事",
    property_name: "テスト物件A",
    final_approved_at: null,
  };

  it("そのまま通す (folio では加工しない)", async () => {
    const row = listItem(filled);
    const { impl } = fakeFetch(() => json({ items: [row] }));
    expect(await createTenmatsuClient({ token: "t", fetchImpl: impl }).list()).toEqual([row]);
  });

  it("項目が無い古い記録も落とさない (空欄で出すため)", async () => {
    const { impl } = fakeFetch(() => json({ items: [oldShapeItem] }));
    const items = await createTenmatsuClient({ token: "t", fetchImpl: impl }).list();
    expect(items).toHaveLength(1);
    expect(items[0].property_name).toBeUndefined();
    expect(items[0].amount).toBeUndefined();
  });

  it("null で来ても落とさない (サーバーは未取得を null で返す)", () => {
    const nulls = {
      shinsei_date: null,
      shinseisha: null,
      amount: null,
      payee: null,
      property_name: null,
      final_approved_at: null,
    };
    expect(isListItemLike({ ...oldShapeItem, ...nulls })).toBe(true);
  });

  it("型が違う行は捨てる", () => {
    expect(isListItemLike({ ...oldShapeItem, amount: 71500 })).toBe(false);
    expect(isListItemLike({ ...oldShapeItem, property_name: { name: "x" } })).toBe(false);
    expect(isListItemLike({ ...oldShapeItem, shinsei_date: 20260901 })).toBe(false);
  });

  it("保存して読み直しても消えない形になっている", () => {
    // IndexedDB は structured clone なので、この形がそのまま往復できることを固定する
    const row = listItem(filled);
    expect(isListItemLike(JSON.parse(JSON.stringify(row)))).toBe(true);
  });
});

describe("疎通確認の新しいフィールド", () => {
  it("読める", async () => {
    const { impl } = fakeFetch(() => json(health({ demo: true, max_per_run: 25 })));
    const h = await createTenmatsuClient({ token: "t", fetchImpl: impl }).health();
    expect(h.demo).toBe(true);
    expect(h.max_per_run).toBe(25);
    expect(h.max_per_run_min).toBe(1);
    expect(h.max_per_run_max).toBe(100);
  });

  it("返さない古いサーバーでも落ちない", async () => {
    const { impl } = fakeFetch(() => json(oldHealth));
    const h = await createTenmatsuClient({ token: "t", fetchImpl: impl }).health();
    expect(h.ok).toBe(true);
    expect(h.max_per_run).toBeUndefined();
    expect(h.demo).toBeUndefined();
  });
});

describe("件数の上下限", () => {
  it("サーバーの値をそのまま使う", () => {
    expect(resolveRunLimits(health())).toEqual({
      value: 10,
      min: 1,
      max: 100,
      fromServer: true,
    });
  });

  it("古いサーバー・繋ぐ前は折り込みの既定値を使う", () => {
    const fallback = { value: 10, min: 1, max: 100, fromServer: false };
    expect(resolveRunLimits(oldHealth)).toEqual(fallback);
    expect(resolveRunLimits(null)).toEqual(fallback);
    expect(resolveRunLimits(undefined)).toEqual(fallback);
  });

  it("既定値が上下限の外なら丸める", () => {
    expect(resolveRunLimits(health({ max_per_run: 500 })).value).toBe(100);
    expect(resolveRunLimits(health({ max_per_run: 0 })).value).toBe(1);
  });

  it("上下限が逆転していても入力できる値にする", () => {
    const r = resolveRunLimits(health({ max_per_run_min: 100, max_per_run_max: 1 }));
    expect(r.min).toBe(1);
    expect(r.max).toBe(100);
  });

  it("整数でない値は無視して既定値を使う", () => {
    expect(resolveRunLimits(health({ max_per_run: Number.NaN })).value).toBe(10);
    expect(resolveRunLimits(health({ max_per_run: 10.5 })).value).toBe(10);
  });

  it("version では判定しない (増えないため)", () => {
    // 同じ version なのに答えは逆になる
    expect(resolveRunLimits(health({ version: 1 })).fromServer).toBe(true);
    expect(resolveRunLimits({ ...oldHealth, version: 1 }).fromServer).toBe(false);
  });
});

describe("完了フラグの更新", () => {
  const okFlags = (item: unknown = listItem({ budget_entered: true })) =>
    fakeFetch(() => json({ ok: true, item }));

  it("伝票No.と変えるフラグだけを本文で送る", async () => {
    const { impl, calls } = okFlags();
    await createTenmatsuClient({ token: "tok-1", fetchImpl: impl }).setFlags("TE00009001", {
      budget_entered: true,
    });
    expect(calls[0].url.pathname).toBe("/flags");
    expect(calls[0].init.method).toBe("POST");
    expect(headerOf(calls[0].init, "Content-Type")).toBe("application/json");
    expect(headerOf(calls[0].init, "X-Tenmatsu-Token")).toBe("tok-1");
    expect(bodyOf(calls[0].init)).toEqual({ denpyo_no: "TE00009001", budget_entered: true });
  });

  it("2つ同時にも送れる", async () => {
    const { impl, calls } = okFlags();
    await createTenmatsuClient({ token: "t", fetchImpl: impl }).setFlags("TE1", {
      budget_entered: true,
      cloud_stored: false,
    });
    expect(bodyOf(calls[0].init)).toEqual({
      denpyo_no: "TE1",
      budget_entered: true,
      cloud_stored: false,
    });
  });

  it("false も送る (チェックを外せる)", async () => {
    const { impl, calls } = okFlags();
    await createTenmatsuClient({ token: "t", fetchImpl: impl }).setFlags("TE1", {
      budget_entered: false,
    });
    expect(bodyOf(calls[0].init)).toEqual({ denpyo_no: "TE1", budget_entered: false });
  });

  it("フラグを1つも指定しなければ通信せずに例外にする", async () => {
    const { impl, calls } = okFlags();
    const e = await failureOf(() =>
      createTenmatsuClient({ token: "t", fetchImpl: impl }).setFlags("TE1", {}),
    );
    expect(e.message).toBe(EMPTY_FLAGS_MESSAGE);
    expect(e.kind).toBe("badRequest");
    expect(e.status).toBeNull();
    expect(calls.length).toBe(0);
  });

  it("undefined だけを渡した場合も通信しない", async () => {
    const { impl, calls } = okFlags();
    const e = await failureOf(() =>
      createTenmatsuClient({ token: "t", fetchImpl: impl }).setFlags("TE1", {
        budget_entered: undefined,
      }),
    );
    expect(e.message).toBe(EMPTY_FLAGS_MESSAGE);
    expect(calls.length).toBe(0);
  });

  it("更新後の行を返す", async () => {
    const row = listItem({ budget_entered: true, flags_updated_at: "2026-09-04T18:20:00" });
    const { impl } = okFlags(row);
    const got = await createTenmatsuClient({ token: "t", fetchImpl: impl }).setFlags("TE1", {
      budget_entered: true,
    });
    expect(got).toEqual(row);
  });

  it("item が null でも例外にしない (保存は済んでいる)", async () => {
    const { impl } = okFlags(null);
    const got = await createTenmatsuClient({ token: "t", fetchImpl: impl }).setFlags("TE1", {
      budget_entered: true,
    });
    expect(got).toBeNull();
  });

  it("item が入っていない応答でも null を返す", async () => {
    const { impl } = fakeFetch(() => json({ ok: true }));
    expect(
      await createTenmatsuClient({ token: "t", fetchImpl: impl }).setFlags("TE1", {
        cloud_stored: true,
      }),
    ).toBeNull();
  });

  it("記録の無い伝票は notFound で返す", async () => {
    const { impl } = fakeFetch(() => json({ error: "伝票 TE99999999 の記録がありません" }, 404));
    const e = await failureOf(() =>
      createTenmatsuClient({ token: "t", fetchImpl: impl }).setFlags("TE99999999", {
        budget_entered: true,
      }),
    );
    expect(e.kind).toBe("notFound");
    expect(e.status).toBe(404);
    expect(e.message).toBe("伝票 TE99999999 の記録がありません");
  });

  it("JSONの形が違うと言われた400もそのまま出す", async () => {
    const { impl } = fakeFetch(() => json({ error: "JSONのオブジェクトを送ってください" }, 400));
    const e = await failureOf(() =>
      createTenmatsuClient({ token: "t", fetchImpl: impl }).setFlags("TE1", {
        budget_entered: true,
      }),
    );
    expect(e.kind).toBe("badRequest");
    expect(e.message).toBe("JSONのオブジェクトを送ってください");
  });

  it("processed.json が壊れているときの案内をそのまま出す", async () => {
    const message =
      "/Users/x/processed.json が壊れています（Expecting value）。" +
      "1つ前の内容が /Users/x/processed.json.bak に残っています。" +
      "中身を確認して問題なければ processed.json にコピーしてください。";
    const { impl } = fakeFetch(() => json({ error: message }, 500));
    const e = await failureOf(() =>
      createTenmatsuClient({ token: "t", fetchImpl: impl }).setFlags("TE1", {
        budget_entered: true,
      }),
    );
    expect(e.kind).toBe("server");
    expect(e.message).toBe(message);
  });

  it("401 はフラグの更新でも例外にする", async () => {
    const { impl } = fakeFetch(() => json({ error: "トークンが違います" }, 401));
    const e = await failureOf(() =>
      createTenmatsuClient({ token: "bad", fetchImpl: impl }).setFlags("TE1", {
        budget_entered: true,
      }),
    );
    expect(e.kind).toBe("auth");
  });

  it("通信そのものが失敗したら接続の案内になる", async () => {
    const { impl } = fakeFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const e = await failureOf(() =>
      createTenmatsuClient({ token: "t", fetchImpl: impl }).setFlags("TE1", {
        budget_entered: true,
      }),
    );
    expect(e.kind).toBe("network");
    expect(e.message).toBe(NETWORK_FAILURE_MESSAGE);
  });
});

describe("種類 (kind) の付け方", () => {
  const senketsu = (impl: typeof fetch) =>
    createTenmatsuClient({ token: "t", kind: "senketsu", fetchImpl: impl });

  it("GET はクエリに kind を足す", async () => {
    const { impl, calls } = fakeFetch(() => json({ ok: true, items: [] }));
    const c = senketsu(impl);
    await c.health();
    await c.status();
    await c.list();
    expect(calls.map((x) => `${x.url.pathname}?${x.url.searchParams.get("kind")}`)).toEqual([
      "/health?senketsu",
      "/status?senketsu",
      "/list?senketsu",
    ]);
  });

  it("★すでにクエリがある /file にも足す (no はそのまま)", async () => {
    const { impl, calls } = fakeFetch(() => new Response("%PDF-1.4", { status: 200 }));
    await senketsu(impl).filePdf("TE 00#1");
    expect(calls[0].url.searchParams.get("no")).toBe("TE 00#1");
    expect(calls[0].url.searchParams.get("kind")).toBe("senketsu");
  });

  it("POST は本文に kind を足す", async () => {
    const { impl, calls } = fakeFetch(() => json({ ok: true, status: status() }));
    const c = senketsu(impl);
    await c.run();
    await c.run({ maxPerRun: 5 });
    expect(calls.map((x) => bodyOf(x.init))).toEqual([
      { kind: "senketsu" },
      { max_per_run: 5, kind: "senketsu" },
    ]);
  });

  it("/flags も本文に kind が入る", async () => {
    const { impl, calls } = fakeFetch(() => json({ ok: true, item: null }));
    await senketsu(impl).setFlags("SE00003001", { cloud_stored: true });
    expect(bodyOf(calls[0].init)).toEqual({
      denpyo_no: "SE00003001",
      cloud_stored: true,
      kind: "senketsu",
    });
  });

  it("★顛末書 (kind なし) は今までどおり付けない", async () => {
    const { impl, calls } = fakeFetch(() => json({ ok: true, items: [], status: status() }));
    const c = createTenmatsuClient({ token: "t", fetchImpl: impl });
    await c.list();
    await c.run();
    expect(calls[0].url.search).toBe("");
    expect(calls[0].url.searchParams.has("kind")).toBe(false);
    expect(bodyOf(calls[1].init)).toEqual({});
  });
});

describe("種類ごとのフラグ", () => {
  it("★その種類のフラグだけで「分かる行」を判定する", () => {
    const onlyCloud: ListItem = {
      denpyo_no: "SE00003001",
      file: "専決決裁書No.3001.pdf",
      at: null,
      exists: true,
      pages: 2,
      size: 100,
      cloud_stored: false,
      completed: false,
    };
    expect(hasFlags(onlyCloud, ["cloud_stored"])).toBe(true);
    expect(hasFlags(onlyCloud)).toBe(false); // 顛末書の判定では「分からない行」
  });

  it("表題を通す (専決決裁書だけが返す)", () => {
    expect(isListItemLike({ ...listItem(), title: "外壁補修" })).toBe(true);
    expect(isListItemLike({ ...listItem(), title: null })).toBe(true);
    expect(isListItemLike({ ...listItem(), title: 1 })).toBe(false);
  });

  it("完了の文言に種類の名前を入れられる", () => {
    const done = status({ state: "done", processed: 0, remaining: 0 });
    expect(describeCompletion(done)?.message).toContain("顛末書");
    expect(describeCompletion(done, "専決決裁書")?.message).toContain("専決決裁書");
  });
});
