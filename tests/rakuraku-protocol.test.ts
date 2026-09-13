import { describe, expect, it } from "vitest";
import {
  type RakurakuEvent,
  isTerminalEvent,
  parseEventLine,
  parseFetchRequest,
  parseScanRequest,
  readNdjson,
} from "@/lib/rakuraku/protocol";

const VALID = { sessionToken: "a.b.c", kind: "tenmatsu", deptCode: "1900", done: ["TE00009001"], limit: 10 };

describe("/scan の本文を確かめる", () => {
  it("正しい本文はそのまま通す", () => {
    expect(parseScanRequest(VALID)).toEqual({ ok: true, value: VALID });
  });

  it("部門の切り替えが無いアカウントは deptCode を null で送れる", () => {
    const parsed = parseScanRequest({ ...VALID, deptCode: null });
    expect(parsed.ok && parsed.value.deptCode).toBeNull();
  });

  it("ページ数の上限は 1〜20 で渡せる", () => {
    const parsed = parseScanRequest({ ...VALID, maxPages: 3 });
    expect(parsed.ok && parsed.value.maxPages).toBe(3);
  });

  it.each([0, 101, 1.5, "10", null])("★1回に取る件数が範囲外（%s）なら丸めずに断る", (limit) => {
    const parsed = parseScanRequest({ ...VALID, limit });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("1〜100");
  });

  it.each([0, 21, 2.5])("ページ数が範囲外（%s）なら断る", (maxPages) => {
    expect(parseScanRequest({ ...VALID, maxPages }).ok).toBe(false);
  });

  it.each([
    ["種類が知らないもの", { kind: "keihi" }],
    ["sessionToken が無い", { sessionToken: "" }],
    ["部門の値に記号", { deptCode: "1900;drop" }],
    ["部門の値が数値", { deptCode: 1900 }],
    ["取得済みが配列でない", { done: "TE00009001" }],
    ["取得済みに文字でないもの", { done: [1] }],
    ["取得済みに長すぎる値", { done: ["x".repeat(65)] }],
  ])("%sなら断る", (_label, patch) => {
    expect(parseScanRequest({ ...VALID, ...patch }).ok).toBe(false);
  });

  it("本文がオブジェクトでなければ断る", () => {
    expect(parseScanRequest(null).ok).toBe(false);
    expect(parseScanRequest([VALID]).ok).toBe(false);
  });
});

function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<RakurakuEvent[]> {
  const out: RakurakuEvent[] = [];
  for await (const event of readNdjson(stream)) out.push(event);
  return out;
}

describe("流れてきた行を読む", () => {
  it("行の途中で区切られても、1行ずつ読める", async () => {
    const events = await readAll(streamOf(['{"type":"log","li', 'ne":"a"}\n{"type":"do', 'ne"}\n']));
    expect(events).toEqual([{ type: "log", line: "a" }, { type: "done" }]);
  });

  it("★日本語の1文字がバイトの途中で区切られても化けない", async () => {
    const bytes = new TextEncoder().encode('{"type":"log","line":"顛末書"}\n');
    const cut = bytes.indexOf(0xe9) + 1; // 「顛」の1バイト目の直後
    const events = await readAll(streamOf([bytes.slice(0, cut), bytes.slice(cut)]));
    expect(events).toEqual([{ type: "log", line: "顛末書" }]);
  });

  it("最後の行に改行が無くても読む・空行は飛ばす", async () => {
    expect(await readAll(streamOf(['\n{"type":"ping"}\n\n{"type":"done"}']))).toEqual([
      { type: "ping" },
      { type: "done" },
    ]);
  });

  it("★壊れた行は読み飛ばさずに失敗させる（途中で切れたのを成功と取り違えない）", async () => {
    await expect(readAll(streamOf(['{"type":"log","line":"a"}\n{"type":"do']))).rejects.toThrow("読めませんでした");
    expect(() => parseEventLine('{"line":"type が無い"}')).toThrow("形が不正");
  });

  it("途中でやめたら、読み取りを取り消す（サーバー側にも伝わる）", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"type":"ping"}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const event of readNdjson(stream)) {
      expect(event.type).toBe("ping");
      break;
    }
    expect(cancelled).toBe(true);
  });

  it("done と error だけが最後の行", () => {
    expect(isTerminalEvent({ type: "done" })).toBe(true);
    expect(
      isTerminalEvent({ type: "error", code: "INTERNAL", message: "x", retryable: false, sessionLost: false }),
    ).toBe(true);
    expect(isTerminalEvent({ type: "ping" })).toBe(false);
    expect(isTerminalEvent({ type: "log", line: "x" })).toBe(false);
  });
});

describe("/fetch の本文を確かめる", () => {
  const FETCH = { sessionToken: "a.b.c", kind: "senketsu", denpyoNo: "SE00003001", href: "https://example.test/abcd/detail?no=1", deptCode: "1900" };

  it("正しい本文はそのまま通す（伝票No.の前後の空白は落とす）", () => {
    expect(parseFetchRequest({ ...FETCH, denpyoNo: " SE00003001 " })).toEqual({ ok: true, value: FETCH });
  });

  it("伝票画面の URL が分からない伝票は href を null で送れる", () => {
    const parsed = parseFetchRequest({ ...FETCH, href: null, deptCode: null });
    expect(parsed.ok && parsed.value.href).toBeNull();
  });

  it.each([
    ["伝票No.が空", { denpyoNo: " " }],
    ["伝票No.が長すぎる", { denpyoNo: "x".repeat(65) }],
    ["href が空文字", { href: "" }],
    ["href が長すぎる", { href: `https://example.test/${"x".repeat(2100)}` }],
    ["href が文字でない", { href: 1 }],
    ["href が無い", { href: undefined }],
    ["部門の値が不正", { deptCode: "19 00" }],
    ["種類が不正", { kind: "keihi" }],
  ])("%sなら断る", (_label, patch) => {
    expect(parseFetchRequest({ ...FETCH, ...patch }).ok).toBe(false);
  });
});
