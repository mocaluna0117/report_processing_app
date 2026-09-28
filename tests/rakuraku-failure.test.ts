import { afterEach, describe, expect, it, vi } from "vitest";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { FAILURE_SIGN_PATTERN, failureSign } from "@/lib/rakuraku/failure";
import { log } from "@/lib/rakuraku/log";
import { readNdjson } from "@/lib/rakuraku/protocol";
import { ndjsonResponse } from "@/lib/rakuraku/stream";

/** Playwright の page.goto が投げる形（本文に移動先の URL が入る） */
const gotoError = (first: string, name = "Error") => {
  const e = new Error(`page.goto: ${first}\nCall log:\n  - navigating to "https://example.test/list?denpyoNo=12345", waiting until "load"`);
  e.name = name;
  return e;
};

describe("failureSign: ブラウザの失敗を決まった符号にする", () => {
  it.each([
    ["net::ERR_CONNECTION_RESET at https://example.test/top?x=1", "net::ERR_CONNECTION_RESET"],
    ["net::ERR_NAME_NOT_RESOLVED at https://example.test/", "net::ERR_NAME_NOT_RESOLVED"],
    ["net::ERR_ABORTED; maybe frame was detached?", "net::ERR_ABORTED"],
    ["Navigation failed because page crashed!", "PAGE_CRASHED"],
    ["Target page, context or browser has been closed", "TARGET_CLOSED"],
    ["Target closed", "TARGET_CLOSED"],
    ['Navigation to "https://example.test/a" is interrupted by another navigation to "https://example.test/b"', "NAV_INTERRUPTED"],
    ["Download is starting", "DOWNLOAD_STARTED"],
    ["Timeout 30000ms exceeded.", "TIMEOUT"],
  ])("%s → %s", (first, sign) => {
    expect(failureSign(gotoError(first))).toBe(sign);
  });

  it("TimeoutError は本文を見ずに TIMEOUT", () => {
    expect(failureSign(gotoError("何か", "TimeoutError"))).toBe("TIMEOUT");
  });

  it("見分けられないものは例外の名前（今までと同じ）", () => {
    expect(failureSign(gotoError("知らない失敗"))).toBe("Error");
    expect(failureSign(new TypeError("x"))).toBe("TypeError");
    expect(failureSign("文字列")).toBe("Error");
    expect(failureSign(null)).toBe("Error");
  });

  it("★名前が符号の形でなければ使わない（自由な文字列を通さない）", () => {
    const e = new Error("x");
    e.name = "伝票 12345";
    expect(failureSign(e)).toBe("Error");
  });

  it("★どの符号も形が決まっていて、URL・伝票No. を含まない", () => {
    for (const first of [
      "net::ERR_CONNECTION_RESET at https://example.test/top?denpyoNo=12345",
      'Navigation to "https://example.test/?denpyoNo=12345" is interrupted by another navigation to "x"',
    ]) {
      const sign = failureSign(gotoError(first));
      expect(sign).toMatch(FAILURE_SIGN_PATTERN);
      expect(sign).not.toContain("12345");
      expect(sign).not.toContain("example.test");
    }
  });
});

describe("ログに符号を残す", () => {
  afterEach(() => vi.restoreAllMocks());

  const logged = () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    return () => spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
  };

  it("形の合う符号だけを残し、合わないものは捨てる", () => {
    const lines = logged();
    log("list", { ok: false, code: "TENANT_UNREACHABLE", detail: "net::ERR_CONNECTION_RESET" });
    log("list", { ok: false, code: "TENANT_UNREACHABLE", detail: "https://example.test/?denpyoNo=12345" });
    expect(lines()).toEqual([
      { stage: "list", ok: false, code: "TENANT_UNREACHABLE", detail: "net::ERR_CONNECTION_RESET" },
      { stage: "list", ok: false, code: "TENANT_UNREACHABLE" },
    ]);
  });

  it("流す応答が失敗で終わったとき、エラーの符号をログに添える", async () => {
    const lines = logged();
    const response = ndjsonResponse(
      new Request("http://localhost/api/rakuraku/scan", { method: "POST" }),
      async () => {
        throw new RakurakuError("TENANT_UNREACHABLE", "楽楽精算の画面に繋がりませんでした（PAGE_CRASHED）", {
          retryable: true,
          detail: "PAGE_CRASHED",
        });
      },
      { stage: "list", startedAt: Date.now() },
    );
    for await (const _ of readNdjson(response.body!)) {
      /* 最後まで読む */
    }
    await vi.waitFor(() => expect(lines().length).toBeGreaterThan(0));
    expect(lines()[0]).toMatchObject({ stage: "list", ok: false, code: "TENANT_UNREACHABLE", detail: "PAGE_CRASHED" });
  });
});
