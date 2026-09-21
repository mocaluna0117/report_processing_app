import { describe, expect, it } from "vitest";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { sendFile } from "@/lib/rakuraku/file-frames";
import type { FetchRequest, ScanRequest } from "@/lib/rakuraku/protocol";
import { type EventSink, ndjsonResponse } from "@/lib/rakuraku/stream";
import { RakurakuApiError, createRakurakuApi } from "@/lib/tenmatsu/local/server-api";

/** 本物の応答の作り（lib/rakuraku/stream.ts）で答える作り物の fetch */
function fakeFetch(routes: Record<string, (body: unknown) => Response | Promise<Response>>) {
  const calls: { path: string; body: unknown; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ path, body, init: init ?? {} });
    const route = routes[path];
    if (!route) throw new TypeError("Failed to fetch");
    return await route(body);
  }) as typeof fetch;
  return { impl, calls };
}

const stream = (run: (sink: EventSink) => Promise<void>) =>
  ndjsonResponse(new Request("http://localhost/api/rakuraku/x", { method: "POST" }), run, { stage: "list" });

const SCAN: ScanRequest = { sessionToken: "t", kind: "tenmatsu", deptCode: "1800", done: [], limit: 1 };
const FETCH: FetchRequest = { sessionToken: "t", kind: "tenmatsu", denpyoNo: "TE1", href: "https://example.test/abcd/d?no=1", deptCode: null };

describe("Folio のサーバーを呼ぶ", () => {
  it("ログイン: 成功ならトークン、失敗なら符号つきの失敗（やり直しはしない）", async () => {
    const ok = fakeFetch({ "/api/rakuraku/login": () => Response.json({ ok: true, sessionToken: "sealed" }) });
    // 期限を返さない (古い) サーバーでは expiresAt は null
    expect(await createRakurakuApi({ fetchImpl: ok.impl }).login("99-test", "架空")).toEqual({
      sessionToken: "sealed",
      expiresAt: null,
    });
    const withExpiry = fakeFetch({
      "/api/rakuraku/login": () => Response.json({ ok: true, sessionToken: "sealed", expiresAt: 1_900_000_000_000 }),
    });
    expect(await createRakurakuApi({ fetchImpl: withExpiry.impl }).login("99-test", "架空")).toEqual({
      sessionToken: "sealed",
      expiresAt: 1_900_000_000_000,
    });
    expect(ok.calls[0].body).toEqual({ userId: "99-test", password: "架空" });
    expect(ok.calls[0].init.credentials).toBe("same-origin");

    const ng = fakeFetch({ "/api/rakuraku/login": () => Response.json({ ok: false, code: "LOGIN_FAILED", message: "やり直しません" }) });
    const error = await createRakurakuApi({ fetchImpl: ng.impl }).login("99-test", "違う").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "LOGIN_FAILED", message: "やり直しません", sessionLost: false });
    expect(ng.calls).toHaveLength(1);
  });

  it("★一覧: 進捗の行と新しいログイン状態を渡しながら、対象を返す", async () => {
    const { impl } = fakeFetch({
      "/api/rakuraku/scan": () =>
        stream(async (sink) => {
          sink.progress("collect", "対象を抽出しています");
          sink.log("  1ページ目: 3行");
          await sink.send({ type: "session", sessionToken: "new-token" });
          await sink.send({
            type: "targets",
            items: [{ denpyoNo: "TE1", href: null, meta: { shinsei_date: "2026/09/10" } }],
            scanned: 3,
            pages: 1,
            total: 3,
            last: 3,
            stoppedEarly: false,
            reason: null,
            department: { code: "1800", label: "アフターメンテナンス課(1800)" },
          });
        }),
    });
    const lines: string[] = [];
    const tokens: string[] = [];
    const messages: string[] = [];
    const result = await createRakurakuApi({ fetchImpl: impl }).scan(SCAN, {
      log: (l) => lines.push(l),
      session: (t) => tokens.push(t),
      progress: (_s, m) => messages.push(m),
    });
    expect(result.items.map((i) => i.denpyoNo)).toEqual(["TE1"]);
    expect(result.department?.code).toBe("1800");
    expect(lines).toEqual(["  1ページ目: 3行"]);
    expect(tokens).toEqual(["new-token"]);
    expect(messages).toEqual(["対象を抽出しています"]);
  });

  it("★伝票: 項目・本体・添付・取れなかった添付を受け取る（ファイルは中身まで確かめて組み立てる）", async () => {
    const bodyBytes = new TextEncoder().encode("%PDF-1.4 本体");
    const { impl } = fakeFetch({
      "/api/rakuraku/fetch": () =>
        stream(async (sink) => {
          await sink.send({ type: "fields", fields: { shinsei_date: "2026/09/10 11:37:00" } });
          await sendFile(sink.send, { role: "body", index: 0, name: "本体", ext: ".pdf", bytes: bodyBytes });
          await sink.send({ type: "attachments", names: ["見積.pdf", "写真.jpg"] });
          await sendFile(sink.send, { role: "attachment", index: 1, name: "見積.pdf", ext: ".pdf", bytes: new Uint8Array([1, 2]) });
          await sink.send({ type: "attachment.failed", index: 2, name: "写真.jpg", code: "ATTACHMENT_FAILED", reason: "始まりませんでした", retryable: true });
        }),
    });
    const result = await createRakurakuApi({ fetchImpl: impl }).fetch(FETCH);
    expect(result.fields).toEqual({ shinsei_date: "2026/09/10 11:37:00" });
    expect(result.body?.bytes).toEqual(bodyBytes);
    expect(result.attachmentNames).toEqual(["見積.pdf", "写真.jpg"]);
    expect(result.attachments.map((a) => [a.index, a.ext])).toEqual([[1, ".pdf"]]);
    expect(result.failures).toEqual([{ index: 2, name: "写真.jpg", code: "ATTACHMENT_FAILED", reason: "始まりませんでした", retryable: true }]);
  });

  it("★最後の行が error なら、その符号の失敗にする（見送れるか・ログインし直しが要るかも渡す）", async () => {
    const { impl } = fakeFetch({
      "/api/rakuraku/fetch": () =>
        stream(async (sink) => {
          await sink.send({ type: "fields", fields: {} });
          throw new RakurakuError("BODY_PDF_FAILED", "本体PDFを取れませんでした", { retryable: true });
        }),
    });
    const error = await createRakurakuApi({ fetchImpl: impl }).fetch(FETCH).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RakurakuApiError);
    expect(error).toMatchObject({ code: "BODY_PDF_FAILED", retryable: true, sessionLost: false });
  });

  it("★最後の行が来ないまま終わったら、途中で切れたとして失敗にする（途中までの結果で進まない）", async () => {
    const { impl } = fakeFetch({
      "/api/rakuraku/fetch": () =>
        new Response(new TextEncoder().encode('{"type":"fields","fields":{}}\n{"type":"file.begin","id":"a","role":"body","index":0,"name":"本体","ext":".pdf","bytes":10}\n'), {
          headers: { "content-type": "application/x-ndjson" },
        }),
    });
    const error = await createRakurakuApi({ fetchImpl: impl }).fetch(FETCH).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "STREAM_CUT" });
  });

  it("本体が届かないまま done になっても、成功にしない", async () => {
    const { impl } = fakeFetch({ "/api/rakuraku/fetch": () => stream(async (sink) => sink.send({ type: "fields", fields: {} })) });
    expect(await createRakurakuApi({ fetchImpl: impl }).fetch(FETCH).catch((e: unknown) => e)).toMatchObject({ code: "STREAM_CUT" });
  });

  it("Folio へのログインが切れている（401）・通信できない、を見分ける", async () => {
    const unauthorized = fakeFetch({ "/api/rakuraku/scan": () => new Response("認証が必要です", { status: 401 }) });
    expect(await createRakurakuApi({ fetchImpl: unauthorized.impl }).scan(SCAN).catch((e: unknown) => e)).toMatchObject({ code: "UNAUTHORIZED" });
    const offline = fakeFetch({});
    expect(await createRakurakuApi({ fetchImpl: offline.impl }).scan(SCAN).catch((e: unknown) => e)).toMatchObject({ code: "NETWORK", retryable: true });
  });

  it("添付の取り直し: 頼んだ番号のファイルを返す", async () => {
    const { impl, calls } = fakeFetch({
      "/api/rakuraku/attachment": () =>
        stream(async (sink) => {
          await sink.send({ type: "attachments", names: ["見積.pdf", "写真.jpg"] });
          await sendFile(sink.send, { role: "attachment", index: 2, name: "写真.jpg", ext: ".png", bytes: new Uint8Array([9]) });
        }),
    });
    const got = await createRakurakuApi({ fetchImpl: impl }).attachment({ ...FETCH, index: 2, expectedName: "写真.jpg" });
    expect(got).toMatchObject({ index: 2, ext: ".png" });
    expect(calls[0].body).toMatchObject({ index: 2, expectedName: "写真.jpg" });
  });
});

describe("部門を読む", () => {
  it("プルダウンが無いアカウントも成功として受け取る", async () => {
    const { impl } = fakeFetch({
      "/api/rakuraku/departments": () =>
        Response.json({ ok: true, departments: [], current: null, hasDepartmentSelect: false, sessionToken: "s2" }),
    });
    expect(await createRakurakuApi({ fetchImpl: impl }).departments("s1")).toEqual({
      departments: [],
      current: null,
      hasDepartmentSelect: false,
      sessionToken: "s2",
      expiresAt: null,
    });
  });

  it("★やり直してよい失敗かどうかを、サーバーの言うとおりに受け取る", async () => {
    const { impl } = fakeFetch({
      "/api/rakuraku/departments": () =>
        Response.json({ ok: false, code: "TENANT_UNREACHABLE", message: "繋がりません", retryable: true, sessionLost: false }),
    });
    const error = await createRakurakuApi({ fetchImpl: impl })
      .departments("s1")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "TENANT_UNREACHABLE", retryable: true, sessionLost: false });
  });

  it("古いサーバー（この項目が無い）でも、ログインし直しが要るかは今までどおり分かる", async () => {
    const { impl } = fakeFetch({
      "/api/rakuraku/departments": () => Response.json({ ok: false, code: "SESSION_EXPIRED", message: "切れました" }),
    });
    const error = await createRakurakuApi({ fetchImpl: impl })
      .departments("s1")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "SESSION_EXPIRED", sessionLost: true, retryable: false });
  });
});

describe("一覧の経路と画面の下見", () => {
  it("★どの経路で一覧を開いたかを受け取る（ほかの行と混ざらない）", async () => {
    const { impl } = fakeFetch({
      "/api/rakuraku/scan": () =>
        stream(async (sink) => {
          await sink.send({
            type: "route",
            kind: "tenmatsu",
            route: "shinsei",
            label: "ワークフロー（申請検索）",
            scope: "own",
            how: "fallback",
          });
          await sink.send({
            type: "targets",
            items: [],
            scanned: 0,
            pages: 1,
            total: 0,
            last: 0,
            stoppedEarly: false,
            reason: null,
            department: null,
          });
        }),
    });
    const routes: unknown[] = [];
    const others: unknown[] = [];
    await createRakurakuApi({ fetchImpl: impl }).scan(SCAN, {
      route: (event) => routes.push(event),
      log: (line) => others.push(line),
    });
    expect(routes).toEqual([
      { type: "route", kind: "tenmatsu", route: "shinsei", label: "ワークフロー（申請検索）", scope: "own", how: "fallback" },
    ]);
    expect(others).toEqual([]);
  });

  it("画面の下見: 結果を受け取る。届かなければ成功にしない", async () => {
    const report = {
      at: "2026-09-19 00:00:00",
      home: { path: "/", title: "", frames: [] },
      department: { hasSelect: false, count: 0, applied: null, message: null },
      menus: [],
      afterWorkflow: [],
      lists: [],
      clicked: [],
      probes: [],
      details: [],
      notes: [],
    };
    const ok = fakeFetch({
      "/api/rakuraku/survey": () => stream(async (sink) => void (await sink.send({ type: "survey", report }))),
    });
    expect(await createRakurakuApi({ fetchImpl: ok.impl }).survey({ sessionToken: "t", deptCode: null })).toEqual(report);

    const empty = fakeFetch({ "/api/rakuraku/survey": () => stream(async () => undefined) });
    const error = await createRakurakuApi({ fetchImpl: empty.impl })
      .survey({ sessionToken: "t", deptCode: null })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "STREAM_CUT" });
  });
});

describe("捺印決裁書の取得結果を受け取る", () => {
  it("★紐づく専決決裁書の本体・添付・写す項目・組み立ての結果を、自分の本体と分けて受け取る", async () => {
    const { impl } = fakeFetch({
      "/api/rakuraku/fetch": () =>
        stream(async (sink) => {
          await sink.send({ type: "fields", fields: { senketsu_no: "2267" } });
          await sendFile(sink.send, { role: "body", index: 0, name: "本体", ext: ".pdf", bytes: new Uint8Array([1]) });
          await sink.send({ type: "linked.found", denpyoNo: "SE00002267", href: "https://example.test/abcd/d?no=2267" });
          await sink.send({ type: "linked.fields", fields: { payee: "架空塗装" } });
          await sendFile(sink.send, { role: "linked-body", index: 0, name: "専決決裁書 本体（No.2267）", ext: ".pdf", bytes: new Uint8Array([2]) });
          await sink.send({ type: "linked.attachments", names: ["見積総覧（架空邸）.pdf", "写真1.jpg"] });
          await sendFile(sink.send, { role: "linked-attachment", index: 1, name: "見積総覧（架空邸）.pdf", ext: ".pdf", bytes: new Uint8Array([3]) });
          await sink.send({ type: "attachment.failed", role: "linked-attachment", index: 2, name: "写真1.jpg", code: "TIME_BUDGET_EXCEEDED", reason: "時間", retryable: true });
          await sink.send({
            type: "compose",
            linkedNo: "2267",
            pattern: 1,
            picked: [{ index: 1, name: "見積総覧（架空邸）.pdf", group: "summary" }],
            paren: "架空邸",
            parenFrom: "summary",
            finalName: "御見積書（架空邸）.pdf",
            linkReason: null,
          });
        }),
    });
    const result = await createRakurakuApi({ fetchImpl: impl }).fetch({ ...FETCH, kind: "natsuin" });
    expect(result.body?.bytes).toEqual(new Uint8Array([1]));
    expect(result.attachments).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.linked).toMatchObject({
      denpyoNo: "SE00002267",
      fields: { payee: "架空塗装" },
      attachmentNames: ["見積総覧（架空邸）.pdf", "写真1.jpg"],
      failures: [{ index: 2, code: "TIME_BUDGET_EXCEEDED" }],
    });
    expect(result.linked?.body?.bytes).toEqual(new Uint8Array([2]));
    expect(result.linked?.attachments.map((a) => a.index)).toEqual([1]);
    expect(result.compose?.finalName).toBe("御見積書（架空邸）.pdf");
  });

  it("★捺印決裁書で組み立ての結果が届かないまま終わったら、成功にしない", async () => {
    const { impl } = fakeFetch({
      "/api/rakuraku/fetch": () =>
        stream(async (sink) => {
          await sink.send({ type: "fields", fields: {} });
          await sendFile(sink.send, { role: "body", index: 0, name: "本体", ext: ".pdf", bytes: new Uint8Array([1]) });
        }),
    });
    expect(await createRakurakuApi({ fetchImpl: impl }).fetch({ ...FETCH, kind: "natsuin" }).catch((e: unknown) => e)).toMatchObject({ code: "STREAM_CUT" });
  });
});
