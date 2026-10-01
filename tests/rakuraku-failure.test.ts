import { afterEach, describe, expect, it, vi } from "vitest";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { FAILURE_SIGN_PATTERN, crashSigns, failureSign } from "@/lib/rakuraku/failure";
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

/** ブラウザが落ちたときに Playwright が付ける形（末尾に Chromium の出力が付く） */
const crashed = (logs: string[]) =>
  new Error(
    [
      "page.goto: Target page, context or browser has been closed",
      "Browser logs:",
      "<launching> /tmp/chromium --headless=shell --single-process",
      "<launched> pid=42",
      ...logs,
    ].join("\n"),
  );

describe("crashSigns: ブラウザが落ちたときの手がかり（2026-10-01）", () => {
  it("強制終了されたときのシグナルを取る", () => {
    const e = crashed(["[pid=42] <process did exit: exitCode=null, signal=SIGKILL>"]);
    expect(failureSign(e)).toBe("TARGET_CLOSED");
    expect(crashSigns(e)).toEqual({ exit: "SIGKILL" });
  });

  it("終了コードを取る", () => {
    expect(crashSigns(crashed(["[pid=42] <process did exit: exitCode=133, signal=null>"]))).toEqual({ n_exit_code: 133 });
  });

  it("メモリ不足・FATAL の行は数だけ数える", () => {
    const e = crashed([
      "[pid=42][err] [1001/063931.123:FATAL:memory.cc(37)] Out of memory. size=262144",
      "[pid=42][err] Check failed: foo at https://example.test/list?denpyoNo=12345",
    ]);
    expect(crashSigns(e)).toEqual({ n_oom_lines: 1, n_fatal_lines: 2 });
  });

  it("★Chromium の出力が無ければ何も返さない（推測で埋めない）", () => {
    expect(crashSigns(gotoError("Target page, context or browser has been closed"))).toEqual({});
    expect(crashSigns("文字列")).toEqual({});
  });

  it("★Chromium の出力の中の net::ERR_… を、移動の失敗と取り違えない", () => {
    const e = crashed(["[pid=42][err] net::ERR_CONNECTION_RESET while loading https://example.test/x"]);
    expect(failureSign(e)).toBe("TARGET_CLOSED");
  });

  it("★出力の文・URL・伝票No. は返さない", () => {
    const e = crashed(["[pid=42][err] FATAL at https://example.test/list?denpyoNo=12345"]);
    const text = JSON.stringify(crashSigns(e));
    expect(text).not.toContain("12345");
    expect(text).not.toContain("example.test");
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

  it("シグナルは形の合うものだけを残す", () => {
    const lines = logged();
    log("list", { ok: false, exit: "SIGKILL", n_exit_code: 9 });
    log("list", { ok: false, exit: "https://example.test/?denpyoNo=12345" });
    expect(lines()).toEqual([
      { stage: "list", ok: false, exit: "SIGKILL", n_exit_code: 9 },
      { stage: "list", ok: false },
    ]);
  });

  it("★流す応答の最後の1行に、ブラウザの様子と落ちたときの手がかりを足す", async () => {
    const lines = logged();
    const response = ndjsonResponse(
      new Request("http://localhost/api/rakuraku/scan", { method: "POST" }),
      async (sink) => {
        sink.note({ n_launch_seq: 3, ms_instance_up: 1000, n_free_mb: 512 });
        throw new RakurakuError("TENANT_UNREACHABLE", "止まりました", {
          retryable: true,
          detail: "TARGET_CLOSED",
          crash: { exit: "SIGKILL" },
        });
      },
      { stage: "list", startedAt: Date.now() },
    );
    for await (const _ of readNdjson(response.body!)) {
      /* 最後まで読む */
    }
    await vi.waitFor(() => expect(lines().length).toBeGreaterThan(0));
    expect(lines()[0]).toMatchObject({
      stage: "list",
      ok: false,
      code: "TENANT_UNREACHABLE",
      detail: "TARGET_CLOSED",
      exit: "SIGKILL",
      n_launch_seq: 3,
      ms_instance_up: 1000,
      n_free_mb: 512,
    });
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
