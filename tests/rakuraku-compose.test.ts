import type { Browser } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TenantConfig } from "@/lib/rakuraku/config";
import type { DownloadTiming } from "@/lib/rakuraku/download";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { type FetchRun, fetchOne } from "@/lib/rakuraku/fetch-one";
import { KINDS, type RakurakuKind } from "@/lib/rakuraku/kinds";
import { type ComposeEvent, FileAssembler, type RakurakuEvent, type ReceivedFile } from "@/lib/rakuraku/protocol";
import { tryLaunch } from "./rakuraku/helpers/browser";
import { SAMPLE_PDF, startFixtureServer, type FixtureServer } from "./rakuraku/helpers/fixture-server";

// 期待値は移植元 tenmatsu.py の _process_composed と smoke_test.py「捺印決裁書」から写した。すべて架空の画面
const browser: Browser | null = await tryLaunch();
let server: FixtureServer | null = null;

beforeAll(async () => {
  if (browser) server = await startFixtureServer();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const QUICK: DownloadTiming = { printButtonWaitMs: 5_000, printClickWaitMs: 5_000, printPopupWaitMs: 3_000, downloadTimeoutMs: 10_000 };
const tenant = (): TenantConfig => ({ loginUrl: `${server!.url}/` });
const url = (path: string) => `${server!.url}/${path}`;

const natsuin: RakurakuKind = { ...KINDS.natsuin, list: { ...KINDS.natsuin.list, detailUrlMarker: "natsuin_download.html" } };
const senketsu: RakurakuKind = {
  ...KINDS.senketsu,
  listPath: "linked_list.html",
  listUrlMarker: "linked_list.html",
  list: { ...KINDS.senketsu.list, detailUrlMarker: "linked_download.html" },
};

let lines: string[] = [];
beforeEach(() => {
  lines = [];
});

async function run(detail: string, patch: Partial<FetchRun> = {}) {
  const context = await browser!.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const events: RakurakuEvent[] = [];
  const files: ReceivedFile[] = [];
  const assembler = new FileAssembler();
  let error: RakurakuError | null = null;
  try {
    await fetchOne({
      page,
      tenant: tenant(),
      home: url("top_frameset.html"),
      kind: natsuin,
      linkedKind: senketsu,
      request: { denpyoNo: "NA00001001", href: url(detail), deptCode: "1900" },
      listUrlFound: null,
      log: (line) => lines.push(line),
      progress: () => undefined,
      send: async (event) => {
        if (!(await assembler.accept(event, (f) => void files.push(f)))) events.push(event);
      },
      timing: {
        detail: { frameWaitMs: 3_000, reopenWaitMs: 2_000, popupWaitMs: 2_000, readyWaitMs: 2_000 },
        approvalLogWaitMs: 300,
        download: QUICK,
        attachmentTimeoutMs: 3_000,
        requestIntervalMs: 0,
        list: { requestIntervalMs: 0, nextPageWaitMs: 2_000 },
        navigation: { frameWaitMs: 3_000, reopenWaitMs: 2_000, listTableWaitMs: 1_000 },
        department: { requestStartWaitMs: 300 },
      },
      ...patch,
    });
  } catch (e) {
    if (!(e instanceof RakurakuError)) throw e;
    error = e;
  }
  await context.close();
  const compose = events.find((e): e is ComposeEvent => e.type === "compose") ?? null;
  return { events, files, compose, error };
}

describe.skipIf(!browser)("捺印決裁書: 紐づく専決決裁書から材料を集める", () => {
  it("★決定通知書が無いとき: 見積総覧・見積：・写真を取り、御見積書は取らない。名前は見積総覧の括弧から", async () => {
    const { events, files, compose, error } = await run("natsuin_download.html?link=2267");
    expect(error).toBeNull();
    expect(events.find((e) => e.type === "fields")).toMatchObject({ fields: { senketsu_no: "2267", remarks: expect.stringContaining("物件名：架空邸") } });
    expect(events.find((e) => e.type === "linked.found")).toMatchObject({ denpyoNo: "SE00002267" });
    expect(events.find((e) => e.type === "linked.fields")).toEqual({ type: "linked.fields", fields: { payee: "架空塗装", amount: "352,000 円" } });
    expect(events.find((e) => e.type === "linked.attachments")).toEqual({
      type: "linked.attachments",
      names: ["見積総覧（架空邸）.pdf", "見積：架空商店 20260916.pdf", "写真1.jpg", "無関係.pdf", "御見積書（架空邸）.pdf"],
    });
    expect(files.map((f) => [f.role, f.index, f.ext])).toEqual([
      ["body", 0, ".pdf"],
      ["linked-body", 0, ".pdf"],
      ["linked-attachment", 1, ".pdf"],
      ["linked-attachment", 2, ".pdf"],
      ["linked-attachment", 3, ".png"],
    ]);
    expect(files[1].bytes).toEqual(SAMPLE_PDF);
    expect(compose).toEqual({
      type: "compose",
      linkedNo: "2267",
      pattern: 1,
      picked: [
        { index: 1, name: "見積総覧（架空邸）.pdf", group: "summary" },
        { index: 2, name: "見積：架空商店 20260916.pdf", group: "estimate" },
        { index: 3, name: "写真1.jpg", group: "other" },
      ],
      paren: "架空邸",
      parenFrom: "summary",
      finalName: "御見積書（架空邸）.pdf",
      linkReason: null,
    });
    // ★捺印決裁書自身の添付は押していない（結合しない）
    expect(lines.join("\n")).toContain("結合するもの 3件");
  }, 60_000);

  it("★決定通知書があるとき: 決定通知書だけを取り、名前は保険金請求書（…）", async () => {
    const { files, compose } = await run("natsuin_download.html?link=2268");
    expect(files.filter((f) => f.role === "linked-attachment").map((f) => f.index)).toEqual([2]);
    expect(compose).toMatchObject({ pattern: 2, parenFrom: "decision", finalName: "保険金請求書（架空県_架空邸_123）.pdf", linkReason: null });
  }, 60_000);

  it("★番号が読めなければ、一覧を開かずに理由を返す（名前は接頭辞＋下4桁）", async () => {
    const { events, files, compose } = await run("natsuin_download.html?link=");
    expect(events.some((e) => e.type === "linked.found")).toBe(false);
    expect(files.map((f) => f.role)).toEqual(["body"]);
    expect(compose).toMatchObject({ linkedNo: null, picked: [], finalName: "捺印決裁書№1001.pdf", linkReason: "専決決裁書№を読めませんでした" });
  }, 60_000);

  it("伝票画面で読めなくても、一覧で読んだ番号があれば使う", async () => {
    const { compose } = await run("natsuin_download.html?link=", { request: { denpyoNo: "NA00001001", href: url("natsuin_download.html?link="), deptCode: "1900", linkedNo: "00002268" } });
    expect(compose).toMatchObject({ linkedNo: "2268", pattern: 2, linkReason: null });
  }, 60_000);

  it("★一覧に見つからなければ、推測で近い伝票を使わずに理由を返す", async () => {
    const { events, compose } = await run("natsuin_download.html?link=9999");
    expect(events.some((e) => e.type === "linked.found")).toBe(false);
    expect(compose).toMatchObject({ linkedNo: "9999", linkReason: "専決決裁書 No.9999 が専決決裁書の一覧に見つかりませんでした" });
  }, 60_000);

  it("★紐づく伝票の本体が取れなくても、添付は取れるだけ取る", async () => {
    const { files, compose, error } = await run("natsuin_download.html?link=2269");
    expect(error).toBeNull();
    expect(files.map((f) => f.role)).toEqual(["body", "linked-attachment", "linked-attachment", "linked-attachment"]);
    expect(compose?.linkReason).toContain("専決決裁書の本体PDFを取れませんでした");
  }, 90_000);

  it("時間の上限が近ければ、残りの紐づく添付は「時間切れ」として伝える", async () => {
    const { events, files } = await run("natsuin_download.html?link=2267", { attachmentDeadlineAt: Date.now() - 1 });
    expect(files.map((f) => f.role)).toEqual(["body", "linked-body"]);
    const failed = events.filter((e) => e.type === "attachment.failed");
    expect(failed.map((e) => e.type === "attachment.failed" && [e.role, e.index, e.code])).toEqual([
      ["linked-attachment", 1, "TIME_BUDGET_EXCEEDED"],
      ["linked-attachment", 2, "TIME_BUDGET_EXCEEDED"],
      ["linked-attachment", 3, "TIME_BUDGET_EXCEEDED"],
    ]);
  }, 60_000);
});
