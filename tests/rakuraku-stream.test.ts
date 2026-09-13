import { describe, expect, it } from "vitest";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { GuardError } from "@/lib/rakuraku/guard";
import { type RakurakuEvent, readNdjson } from "@/lib/rakuraku/protocol";
import { SessionError } from "@/lib/rakuraku/session";
import { type EventSink, ndjsonResponse, toErrorEvent } from "@/lib/rakuraku/stream";

const request = (signal?: AbortSignal) =>
  new Request("http://localhost/api/rakuraku/scan", { method: "POST", ...(signal ? { signal } : {}) });

async function readAll(response: Response): Promise<RakurakuEvent[]> {
  const out: RakurakuEvent[] = [];
  for await (const event of readNdjson(response.body!)) out.push(event);
  return out;
}

const withoutPings = (events: RakurakuEvent[]) => events.filter((e) => e.type !== "ping");

describe("行ごとの JSON で流す応答", () => {
  it("状態は常に 200、形は NDJSON、キャッシュさせない", async () => {
    const response = ndjsonResponse(request(), async () => undefined, { stage: "list" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await readAll(response);
  });

  it("★送った順に届き、最後に done が付く（待たずに出した行も追い越さない）", async () => {
    const response = ndjsonResponse(
      request(),
      async (sink) => {
        sink.progress("open", "開いています");
        sink.log("  1ページ目");
        await sink.send({ type: "session", sessionToken: "t" });
        sink.log("  2ページ目");
      },
      { stage: "list" },
    );
    expect(withoutPings(await readAll(response))).toEqual([
      { type: "progress", stage: "open", message: "開いています" },
      { type: "log", line: "  1ページ目" },
      { type: "session", sessionToken: "t" },
      { type: "log", line: "  2ページ目" },
      { type: "done" },
    ]);
  });

  it("★失敗は最後の error 行になり、done は付かない", async () => {
    const response = ndjsonResponse(
      request(),
      async (sink) => {
        sink.log("  途中まで");
        throw new RakurakuError("LIST_NOT_PERMITTED", "このアカウントでは顛末書の一覧を開けません");
      },
      { stage: "list" },
    );
    const events = withoutPings(await readAll(response));
    expect(events.at(-1)).toEqual({
      type: "error",
      code: "LIST_NOT_PERMITTED",
      message: "このアカウントでは顛末書の一覧を開けません",
      retryable: false,
      sessionLost: false,
    });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("何も流れない間は生存確認（ping）を送る", async () => {
    const response = ndjsonResponse(
      request(),
      async () => {
        // ほかの検証と並んで走るとタイマーが遅れるので、間隔の10倍以上待つ
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      { stage: "list", pingIntervalMs: 30 },
    );
    const events = await readAll(response);
    expect(events.filter((e) => e.type === "ping").length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("★ブラウザが接続を切ったら、登録した後片付けが呼ばれる", async () => {
    const controller = new AbortController();
    let cleaned = false;
    let sinkRef: EventSink | null = null;
    const response = ndjsonResponse(
      request(controller.signal),
      async (sink) => {
        sinkRef = sink;
        sink.onAbort(() => {
          cleaned = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
      { stage: "list" },
    );
    await readAll(response).catch(() => null);
    expect(cleaned).toBe(true);
    expect(sinkRef!.signal.aborted).toBe(true);
  });

  it("★読む側が途中でやめたら（本文を取り消したら）、次に書こうとした時点で気付く", async () => {
    let cleaned = false;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const response = ndjsonResponse(
      request(),
      async (sink) => {
        sink.onAbort(() => {
          cleaned = true;
        });
        await sink.send({ type: "log", line: "1行目" });
        for (let i = 0; i < 50 && !sink.signal.aborted; i++) {
          await sink.send({ type: "log", line: `${i}` });
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        finished();
      },
      { stage: "list" },
    );
    for await (const event of readNdjson(response.body!)) {
      expect(event).toEqual({ type: "log", line: "1行目" });
      break; // ここで取り消される
    }
    await done;
    expect(cleaned).toBe(true);
  });

  it("すでに切れている接続でも、後片付けは必ず呼ばれる", async () => {
    const controller = new AbortController();
    controller.abort();
    let cleaned = false;
    const response = ndjsonResponse(
      request(controller.signal),
      async (sink) => {
        sink.onAbort(() => {
          cleaned = true;
        });
      },
      { stage: "list" },
    );
    await readAll(response).catch(() => null);
    expect(cleaned).toBe(true);
  });
});

describe("例外を最後の行にする", () => {
  it("部門が選べないときは、選べるものも渡す", () => {
    const error = new RakurakuError("DEPT_NOT_AVAILABLE", "選べません", {
      available: [{ code: "1800", label: "アフターメンテナンス課(1800)" }],
    });
    expect(toErrorEvent(error).available).toEqual([{ code: "1800", label: "アフターメンテナンス課(1800)" }]);
  });

  it("門番の断りは、その符号のまま", () => {
    expect(toErrorEvent(new GuardError("PREVIEW_BLOCKED", "プレビューでは無効")).code).toBe("PREVIEW_BLOCKED");
  });

  it("★封じたセッションが読めない・期限切れはログインし直し", () => {
    const event = toErrorEvent(new SessionError("期限が切れています", "expired"));
    expect(event.code).toBe("SESSION_EXPIRED");
    expect(event.sessionLost).toBe(true);
  });

  it("★鍵が無いのは設定の問題。ログインし直させない", () => {
    const event = toErrorEvent(new SessionError("鍵がありません", "secret"));
    expect(event.code).toBe("DISABLED");
    expect(event.sessionLost).toBe(false);
  });

  it("★知らない例外は1行目だけを短く返す（後ろの行に何が入っていても出さない）", () => {
    const event = toErrorEvent(new Error(`page.goto: Timeout\nCall log:\n  - navigating to "https://example.test/secret?pw=x"`));
    expect(event).toEqual({
      type: "error",
      code: "INTERNAL",
      message: "page.goto: Timeout",
      retryable: false,
      sessionLost: false,
    });
  });
});
