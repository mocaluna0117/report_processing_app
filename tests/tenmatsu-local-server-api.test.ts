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
    expect(await createRakurakuApi({ fetchImpl: ok.impl }).login("99-test", "架空")).toEqual({ sessionToken: "sealed" });
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
