import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFinalApprovedAt } from "@/lib/rakuraku/approval-log";
import type { TenantConfig } from "@/lib/rakuraku/config";
import {
  type DownloadTiming,
  fetchAttachment,
  fetchBodyPdf,
  locateAttachments,
  locatePrintButton,
  looksLikeLoginPage,
} from "@/lib/rakuraku/download";
import { RakurakuError } from "@/lib/rakuraku/errors";
import { type FetchRun, fetchOne, fetchOneAttachment } from "@/lib/rakuraku/fetch-one";
import { KINDS, type RakurakuKind } from "@/lib/rakuraku/kinds";
import { FileAssembler, type RakurakuEvent, type ReceivedFile } from "@/lib/rakuraku/protocol";
import { tryLaunch } from "./rakuraku/helpers/browser";
import { SAMPLE_PDF, SAMPLE_PNG, startFixtureServer, type FixtureServer } from "./rakuraku/helpers/fixture-server";

// 期待値は移植元の検証 (tenmatsu-dl/smoke_test.py「実構造」「印刷ボタン」「印刷の別ウィンドウ」「印刷が押せないとき」「本体PDF」) から写した。
// すべて架空の画面とファイル
const browser: Browser | null = await tryLaunch();
let server: FixtureServer | null = null;

beforeAll(async () => {
  if (browser) server = await startFixtureServer();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/**
 * 検証用に待ち時間を縮める（本番は 10秒・10秒・15秒・60秒）。
 * ★ほかの検証と並んで走ると画面の反応が数秒遅れるので、縮めすぎない（「来ない」ことを確かめる検証だけ短くする）
 */
const QUICK: DownloadTiming = { printButtonWaitMs: 5_000, printClickWaitMs: 5_000, printPopupWaitMs: 8_000, downloadTimeoutMs: 10_000 };
const tenant = (): TenantConfig => ({ loginUrl: `${server!.url}/` });
const url = (path: string) => `${server!.url}/${path}`;

let lines: string[] = [];
const log = (line: string) => lines.push(line);
beforeEach(() => {
  lines = [];
});

async function open(path: string): Promise<Page> {
  const context = await browser!.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(url(path), { waitUntil: "load" });
  return page;
}

async function failure(promise: Promise<unknown>): Promise<RakurakuError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof RakurakuError) return e;
    throw e;
  }
  throw new Error("失敗するはずが、通ってしまった");
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe.skipIf(!browser)("印刷ボタンと添付を見つける", () => {
  it("印刷ボタン（button.accesskeyPrint）を特定できる。「取下げ」「コピー」「閉じる」とは取り違えない", async () => {
    const page = await open("detail_structure.html");
    const button = await locatePrintButton(page.mainFrame(), KINDS.tenmatsu, QUICK);
    expect(await button.innerText()).toContain("印刷");
    expect(await page.locator(KINDS.tenmatsu.detail.printButtonSelector).count()).toBe(1);
    await page.context().close();
  });

  it("★遅れて現れる「印刷」を待って掴む", async () => {
    const page = await open("slow_detail.html");
    const button = await locatePrintButton(page.mainFrame(), KINDS.tenmatsu, QUICK);
    await button.click({ timeout: 1_000 });
    expect(await page.evaluate(() => (window as unknown as { __printClicked?: boolean }).__printClicked)).toBe(true);
    await page.context().close();
  });

  it("印刷ボタンが無い画面では理由を出す（この伝票だけの失敗）", async () => {
    const page = await open("list_empty.html");
    const error = await failure(locatePrintButton(page.mainFrame(), KINDS.tenmatsu, QUICK));
    expect(error.code).toBe("BODY_PDF_FAILED");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("ボタンが見つかりません");
    await page.context().close();
  });

  it("★添付は2件だけ拾う（空きの枠3件と参照リンクは拾わない）・表示順", async () => {
    const page = await open("detail_structure.html");
    const items = await locateAttachments(page.mainFrame(), KINDS.tenmatsu);
    expect(items.map((i) => [i.index, i.name])).toEqual([
      [1, "見積：テスト工業\u300020260916.pdf"],
      [2, "現場写真.jpg"],
    ]);
    for (const item of items) await item.locator.click();
    expect(await page.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked)).toEqual(items.map((i) => i.name));
    await page.context().close();
  });
});

describe.skipIf(!browser)("「印刷」から本体PDFを受け取る", () => {
  const kind = KINDS.tenmatsu;

  it.each([
    ["そのままダウンロードになる", "download"],
    ["★別ウィンドウで開いてダウンロードになる（押した画面だけ見ていると取り逃がす）", "popup-download"],
    ["★about:blank の別ウィンドウが遅れて PDF へ移動する", "late-popup"],
    ["同じ画面の中の枠で開く", "same-frame"],
  ])("%s", async (_label, mode) => {
    const page = await open(`print_variants.html?mode=${mode}`);
    const before = page.context().pages().length;
    const file = await fetchBodyPdf(page, page.mainFrame(), kind, tenant(), log, QUICK);
    expect(file.bytes).toEqual(SAMPLE_PDF);
    expect(file.name.toLowerCase().endsWith(".pdf")).toBe(true);
    // ★開いた別ウィンドウは閉じる
    expect(page.context().pages()).toHaveLength(before);
    await page.context().close();
  });

  it("★待ち時間が足りないと取り逃がす（待ちが効いている証拠）", async () => {
    const page = await open("print_variants.html?mode=late-popup");
    const error = await failure(fetchBodyPdf(page, page.mainFrame(), kind, tenant(), log, { ...QUICK, printPopupWaitMs: 300 }));
    expect(error.code).toBe("BODY_PDF_FAILED");
    expect(error.message).toContain("開いていた別ウィンドウ");
    expect(page.context().pages()).toHaveLength(1);
    await page.context().close();
  });

  it("★PDFではない画面が出るだけなら、PDFとして受け取らずに失敗にする", async () => {
    const page = await open("print_variants.html?mode=preview-only");
    const error = await failure(fetchBodyPdf(page, page.mainFrame(), kind, tenant(), log, { ...QUICK, printPopupWaitMs: 4_000 }));
    expect(error.code).toBe("BODY_PDF_FAILED");
    expect(error.message).toContain("PDFではなく画面が返ってきました");
    await page.context().close();
  });

  it("★ログイン画面が返ってきたら SESSION_EXPIRED", async () => {
    const page = await open("print_variants.html?mode=login");
    const error = await failure(fetchBodyPdf(page, page.mainFrame(), kind, tenant(), log, { ...QUICK, printPopupWaitMs: 4_000 }));
    expect(error.code).toBe("SESSION_EXPIRED");
    expect(error.sessionLost).toBe(true);
    await page.context().close();
  });

  it("押しても何も起きなければ「別ウィンドウは開きませんでした」", async () => {
    const page = await open("print_variants.html?mode=nothing");
    const error = await failure(fetchBodyPdf(page, page.mainFrame(), kind, tenant(), log, { ...QUICK, printPopupWaitMs: 1_500 }));
    expect(error.message).toContain("別ウィンドウは開きませんでした");
    await page.context().close();
  });

  it("★押せないときは「押せませんでした」と言う（承認履歴のダイアログが重なっている）", async () => {
    const page = await open("detail_structure.html");
    await readFinalApprovedAt(page, kind, log); // ダイアログを開いたままにする
    const error = await failure(fetchBodyPdf(page, page.mainFrame(), kind, tenant(), log, { ...QUICK, printClickWaitMs: 1_500 }));
    expect(error.code).toBe("BODY_PDF_FAILED");
    expect(error.message).toContain("押せませんでした");
    expect(error.message).toContain("承認履歴のダイアログ");
    await page.context().close();
  });

  it("ログイン画面の見分け方", () => {
    expect(looksLikeLoginPage(new TextEncoder().encode('<html><input type="password" name="pw"></html>'))).toBe(true);
    expect(looksLikeLoginPage(new TextEncoder().encode("<html><body>印刷の準備</body></html>"))).toBe(false);
    expect(looksLikeLoginPage(SAMPLE_PDF)).toBe(false);
  });
});

describe.skipIf(!browser)("添付を受け取る", () => {
  it("★押してダウンロードを受け取り、拡張子は中身で直す（.jpg と表示されていても中身が PNG なら .png）", async () => {
    const page = await open("detail_download.html");
    const items = await locateAttachments(page.mainFrame(), KINDS.tenmatsu);
    expect(items.map((i) => i.name)).toEqual(["見積書.pdf", "現場写真.jpg", "壊れた添付.pdf", "図面.pdf", "エラー画面.pdf"]);
    const pdf = await fetchAttachment(page, items[0], 3_000);
    expect(pdf).toEqual({ ext: ".pdf", bytes: SAMPLE_PDF });
    const photo = await fetchAttachment(page, items[1], 3_000);
    expect(photo).toEqual({ ext: ".png", bytes: SAMPLE_PNG });
    await page.context().close();
  });

  it("ダウンロードが始まらなければ失敗（理由つき）", async () => {
    const page = await open("detail_download.html");
    const items = await locateAttachments(page.mainFrame(), KINDS.tenmatsu);
    await expect(fetchAttachment(page, items[2], 800)).rejects.toThrow("ダウンロードが始まりませんでした");
    await page.context().close();
  });

  it("★画面（HTML）が返ってきた添付は、PDF の名前でも受け取らない", async () => {
    const page = await open("detail_download.html");
    const items = await locateAttachments(page.mainFrame(), KINDS.tenmatsu);
    await expect(fetchAttachment(page, items[4], 3_000)).rejects.toThrow("画面（HTML）が返ってきました");
    await page.context().close();
  });

  it("★ログイン画面が返ってきたら SESSION_EXPIRED", async () => {
    const page = await open("detail_download.html?mode=login");
    const items = await locateAttachments(page.mainFrame(), KINDS.tenmatsu);
    const error = await failure(fetchAttachment(page, items[0], 3_000));
    expect(error.code).toBe("SESSION_EXPIRED");
    await page.context().close();
  });
});

describe.skipIf(!browser)("伝票1件を取得する（通し）", () => {
  const kind: RakurakuKind = { ...KINDS.tenmatsu, list: { ...KINDS.tenmatsu.list, detailUrlMarker: "detail_download.html" } };

  async function runFetch(
    href: string,
    patch: Partial<FetchRun> = {},
    call: (run: FetchRun) => Promise<unknown> = fetchOne,
  ) {
    const context = await browser!.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const events: RakurakuEvent[] = [];
    const files: ReceivedFile[] = [];
    const assembler = new FileAssembler();
    const run: FetchRun = {
      page,
      tenant: tenant(),
      home: url("top_frameset.html"),
      kind,
      request: { denpyoNo: "TE00009005", href: url(href), deptCode: null },
      listUrlFound: null,
      log,
      progress: () => undefined,
      send: async (event) => {
        if (await assembler.accept(event, (file) => void files.push(file))) return;
        events.push(event);
      },
      timing: {
        detail: { frameWaitMs: 3_000, reopenWaitMs: 2_000, popupWaitMs: 2_000, readyWaitMs: 2_000 },
        approvalLogWaitMs: 500,
        download: QUICK,
        attachmentTimeoutMs: 3_000,
        requestIntervalMs: 0,
      },
      ...patch,
    };
    let error: unknown = null;
    try {
      await call(run);
    } catch (e) {
      error = e;
    }
    const pages = context.pages().length;
    await context.close();
    return { events, files, error: error as RakurakuError | null, pages, pending: assembler.pending };
  }

  it("★項目 → 本体 → 添付の順に流し、取れなかった添付は名前と理由を添えて伝える", async () => {
    const { events, files, error, pages, pending } = await runFetch("detail_download.html");
    expect(error).toBeNull();
    expect(pending).toBe(0);
    expect(events[0]).toMatchObject({ type: "fields", fields: { shinsei_date: "2026/09/04 17:51:38", pj: "9901230105" } });
    expect(files.map((f) => [f.role, f.index, f.name, f.ext])).toEqual([
      ["body", 0, "本体", ".pdf"],
      ["attachment", 1, "見積書.pdf", ".pdf"],
      ["attachment", 2, "現場写真.jpg", ".png"],
      ["attachment", 4, "図面.pdf", ".pdf"],
    ]);
    expect(files[0].bytes).toEqual(SAMPLE_PDF);
    expect(events.find((e) => e.type === "attachments")).toEqual({
      type: "attachments",
      names: ["見積書.pdf", "現場写真.jpg", "壊れた添付.pdf", "図面.pdf", "エラー画面.pdf"],
    });
    const failed = events.filter((e) => e.type === "attachment.failed");
    expect(failed.map((e) => e.type === "attachment.failed" && [e.index, e.name, e.code, e.retryable])).toEqual([
      [3, "壊れた添付.pdf", "ATTACHMENT_FAILED", true],
      [5, "エラー画面.pdf", "ATTACHMENT_FAILED", true],
    ]);
    // ★窓を増やしていない
    expect(pages).toBe(1);
    // ★進捗の行に添付の名前や氏名を出さない
    expect(lines.join("\n")).not.toMatch(/見積書|現場写真|架空/);
  });

  it("★添付が続けて2回失敗したら、セッション切れとみなして止める", async () => {
    const { files, error } = await runFetch("detail_download.html?mode=twofail");
    expect(error?.code).toBe("ATTACHMENT_FAILED");
    expect(error?.sessionLost).toBe(true);
    expect(files.map((f) => f.role)).toEqual(["body"]);
  });

  it("★本体PDFは1回目が駄目でも、伝票画面を開き直してもう一度試す", async () => {
    const { files, error } = await runFetch("detail_download.html?mode=flaky");
    expect(error).toBeNull();
    expect(files[0].role).toBe("body");
    expect(lines.join("\n")).toContain("開き直してもう一度試します");
  }, 60_000);

  it("★本体PDFが2回とも取れなければ BODY_PDF_FAILED（この伝票だけ見送れる）。添付は取りに行かない", async () => {
    const { events, files, error } = await runFetch("detail_download.html?mode=noprint");
    expect(error?.code).toBe("BODY_PDF_FAILED");
    expect(error?.retryable).toBe(true);
    expect(error?.sessionLost).toBe(false);
    expect(files).toEqual([]);
    expect(events.some((e) => e.type === "attachments")).toBe(false);
    // 項目は先に読んで渡してある
    expect(events[0].type).toBe("fields");
  }, 60_000);

  it("★時間の上限が近ければ、残りの添付は取りに行かず「時間切れ」として全部伝える", async () => {
    const { events, files } = await runFetch("detail_download.html", { attachmentDeadlineAt: Date.now() - 1 });
    expect(files.map((f) => f.role)).toEqual(["body"]);
    const failed = events.filter((e) => e.type === "attachment.failed");
    expect(failed).toHaveLength(5);
    expect(failed.every((e) => e.type === "attachment.failed" && e.code === "TIME_BUDGET_EXCEEDED" && e.retryable)).toBe(true);
  });

  it("捺印決裁書は自身の添付を取らない（紐づく専決決裁書から組むため）", async () => {
    const natsuin: RakurakuKind = { ...kind, compose: KINDS.natsuin.compose, id: "natsuin" };
    const { events, files, error } = await runFetch("detail_download.html", { kind: natsuin });
    expect(error).toBeNull();
    expect(files.map((f) => f.role)).toEqual(["body"]);
    expect(events.some((e) => e.type === "attachments")).toBe(false);
  });

  it("★時間切れの添付を、あとから1つだけ取り直せる", async () => {
    const { files, error } = await runFetch("detail_download.html", {}, (run) => fetchOneAttachment(run, 2, "現場写真.jpg"));
    expect(error).toBeNull();
    expect(files.map((f) => [f.role, f.index, f.ext])).toEqual([["attachment", 2, ".png"]]);
  });

  it("★取り直すとき、添付の名前が前と違えば取らない（別の書類を別の枠に入れない）", async () => {
    const { files, error } = await runFetch("detail_download.html", {}, (run) => fetchOneAttachment(run, 2, "見積書.pdf"));
    expect(error?.code).toBe("ATTACHMENT_MISMATCH");
    expect(files).toEqual([]);
    const missing = await runFetch("detail_download.html", {}, (run) => fetchOneAttachment(run, 9, "見積書.pdf"));
    expect(missing.error?.code).toBe("ATTACHMENT_MISMATCH");
  });
});
