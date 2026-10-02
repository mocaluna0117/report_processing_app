import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Metric } from "@/lib/usage/metrics";

// 楽楽精算の流す返事で、利用状況を数える（2026-10-02）。★値はすべて架空。
const scheduled: { id: string | null; metrics: Promise<readonly Metric[]> }[] = [];
vi.mock("@/lib/usage/record", () => ({
  scheduleUsage: (id: string | null, metrics: readonly Metric[] | Promise<readonly Metric[]>) => {
    scheduled.push({ id, metrics: Promise.resolve(metrics) });
  },
}));

const { RakurakuError } = await import("@/lib/rakuraku/errors");
const { readNdjson } = await import("@/lib/rakuraku/protocol");
const { ndjsonResponse } = await import("@/lib/rakuraku/stream");

const request = (signal?: AbortSignal) =>
  new Request("http://localhost/api/rakuraku/scan", { method: "POST", ...(signal ? { signal } : {}) });

async function drain(response: Response) {
  for await (const _ of readNdjson(response.body!)) {
    // 読み切る
  }
}

beforeEach(() => {
  scheduled.length = 0;
});

describe("流す返事の利用状況", () => {
  it("成功したら ok の名前を数える", async () => {
    await drain(ndjsonResponse(request(), async () => undefined, { stage: "list", usage: { id: "kasou-taro", ok: "rk.scan.tenmatsu" } }));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].id).toBe("kasou-taro");
    expect(await scheduled[0].metrics).toEqual(["rk.scan.tenmatsu"]);
  });

  it("失敗したら合計と符号を数える（ok は数えない）", async () => {
    await drain(
      ndjsonResponse(
        request(),
        async () => {
          throw new RakurakuError("LIST_NOT_PERMITTED", "このアカウントでは一覧を開けません");
        },
        { stage: "list", usage: { id: "kasou-taro", ok: "rk.scan.tenmatsu" } },
      ),
    );
    expect(await scheduled[0].metrics).toEqual(["rk.fail", "rk.fail.LIST_NOT_PERMITTED"]);
  });

  it("★本人が閉じた（接続が切れた）ための失敗は数えない", async () => {
    const controller = new AbortController();
    const response = ndjsonResponse(
      request(controller.signal),
      async () => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new RakurakuError("INTERNAL", "閉じられました");
      },
      { stage: "detail", usage: { id: "kasou-taro", ok: "rk.fetch.natsuin" } },
    );
    await drain(response).catch(() => null);
    expect(await scheduled[0].metrics).toEqual([]);
  });

  it("usage を渡さなければ何もしない（今までどおり）", async () => {
    await drain(ndjsonResponse(request(), async () => undefined, { stage: "list" }));
    expect(scheduled).toEqual([]);
  });
});
