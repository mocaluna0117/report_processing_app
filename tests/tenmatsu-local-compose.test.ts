import { beforeEach, describe, expect, it } from "vitest";
import type { ComposeEvent } from "@/lib/rakuraku/protocol";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import { startRun } from "@/lib/tenmatsu/local/job";
import { LOCAL_KINDS } from "@/lib/tenmatsu/local/kind-config";
import { buildListItems, memoryStatsCache } from "@/lib/tenmatsu/local/list";
import type { Manifest } from "@/lib/tenmatsu/local/manifest";
import { completePending } from "@/lib/tenmatsu/local/pending-ops";
import { readRecords } from "@/lib/tenmatsu/local/records";
import { type FetchResult, type LinkedResult, RakurakuApiError } from "@/lib/tenmatsu/local/server-api";
import { FakeFs } from "./helpers/fake-fs";
import { type FakeApiScript, createFakeApi, file, scanOf, target } from "./helpers/fake-rakuraku-api";
import { makePdf, makePng, pageSizes } from "./helpers/pdf-parts";

// 期待値は移植元 tenmatsu.py の _process_composed（並べる・結合する・保留にする）から写した。すべて架空の値

const NOW = new Date(2026, 8, 13, 15, 0, 0);
const natsuin = LOCAL_KINDS.natsuin;

let own: Uint8Array;
let senketsuBody: Uint8Array;
let summary: Uint8Array;
beforeEach(async () => {
  own = await makePdf(1, [320, 320]);
  senketsuBody = await makePdf(1, [310, 310]);
  summary = await makePdf(2, [300, 300]);
});

const compose = (extra: Partial<ComposeEvent> = {}): ComposeEvent => ({
  type: "compose",
  linkedNo: "2267",
  pattern: 1,
  picked: [
    { index: 1, name: "見積総覧（架空邸）.pdf", group: "summary" },
    { index: 3, name: "写真1.jpg", group: "other" },
  ],
  paren: "架空邸",
  parenFrom: "summary",
  finalName: "御見積書（架空邸）.pdf",
  linkReason: null,
  ...extra,
});

const linked = (extra: Partial<LinkedResult> = {}): LinkedResult => ({
  denpyoNo: "SE00002267",
  href: "https://example.test/abcd/detail?no=2267",
  fields: { payee: "架空塗装", amount: "352,000 円" },
  attachmentNames: ["見積総覧（架空邸）.pdf", "無関係.pdf", "写真1.jpg", "御見積書（架空邸）.pdf"],
  body: file("linked-body", 0, "専決決裁書 本体（No.2267）", ".pdf", senketsuBody),
  attachments: [file("linked-attachment", 1, "見積総覧（架空邸）.pdf", ".pdf", summary), file("linked-attachment", 3, "写真1.jpg", ".png", makePng(40, 30))],
  failures: [],
  ...extra,
});

const fetched = (extra: Partial<FetchResult> = {}): FetchResult => ({
  fields: { shinsei_date: "2026/09/05 10:20:30", content: "外壁補修工事の捺印依頼", senketsu_no: "2267", remarks: "物件情報 物件名：架空邸" },
  body: file("body", 0, "本体", ".pdf", own),
  attachmentNames: null,
  attachments: [],
  failures: [],
  linked: linked(),
  compose: compose(),
  ...extra,
});

async function run(script: FakeApiScript) {
  const fs = new FakeFs("捺印決裁書");
  const store = new FolderStore(fs.root);
  let token: string | null = "token-0";
  const api = createFakeApi(script);
  const handle = startRun(
    {
      store,
      cfg: natsuin,
      api,
      auth: { userId: "99-test", password: () => "架空", token: () => token, setToken: (t) => (token = t) },
      deptCode: "1900",
      now: () => NOW,
      sleep: async () => undefined,
    },
    { limit: 5 },
  );
  const status = await handle.finished;
  return { fs, store, api, status, log: handle.snapshot(0).log!.map((l) => l.text) };
}

describe("捺印決裁書を組み立てる（必ずアップロード待ちの保留にする）", () => {
  it("★並びは [0]あとから入れる書類 → 選んだ添付 → 専決決裁書の本体 → 捺印決裁書の本体", async () => {
    const { fs, store, api, status, log } = await run({
      scan: scanOf([target("NA00001001", { senketsu_no: "2267", shinsei_date: "2026/09/05" })]),
      fetch: { NA00001001: fetched() },
    });
    expect(status.state).toBe("done");
    expect(status.processed).toBe(0);
    expect(status.pending).toEqual([{ denpyo_no: "NA00001001", missing: ["あとからアップロードする書類"], awaiting: true }]);
    expect(status.message).toBe("0件を保存しました（1件はアップロード待ち）");
    // 一覧で読んだ紐づく番号を渡している
    expect(api.calls.find((c) => c.method === "fetch")?.request).toMatchObject({ kind: "natsuin", linkedNo: "2267" });

    expect(fs.files().filter((f) => f.startsWith("_保留"))).toEqual([
      "_保留/NA00001001/001_見積総覧（架空邸）.pdf",
      "_保留/NA00001001/002_写真1.png",
      "_保留/NA00001001/003_専決決裁書本体.pdf",
      "_保留/NA00001001/004_本体.pdf",
      "_保留/NA00001001/_merged.pdf",
      "_保留/NA00001001/manifest.json",
    ]);
    const manifest = JSON.parse(fs.text("_保留/NA00001001/manifest.json")!) as Manifest;
    expect(manifest.parts.map((p) => [p.index, p.name, p.status, p.file ?? null])).toEqual([
      [0, "あとからアップロードする書類", "awaiting", null],
      [1, "見積総覧（架空邸）.pdf", "ok", "001_見積総覧（架空邸）.pdf"],
      [2, "写真1.jpg", "ok", "002_写真1.png"],
      [3, "専決決裁書 本体（No.2267）", "ok", "003_専決決裁書本体.pdf"],
      [4, "本体", "ok", "004_本体.pdf"],
    ]);
    expect(manifest.merged_pages).toBe(5);
    expect(await pageSizes(fs.get("_保留/NA00001001/_merged.pdf")!)).toEqual([
      [300, 300],
      [300, 300],
      [842, 595],
      [310, 310],
      [320, 320],
    ]);

    const records = await readRecords(store, natsuin);
    expect(records.pending.NA00001001.missing).toEqual([
      { index: 0, name: "あとからアップロードする書類", reason: "あとからアップロードする書類", awaiting: true },
    ]);
    expect(records.pending.NA00001001.meta).toMatchObject({
      final_name: "御見積書（架空邸）.pdf",
      // ★専決決裁書から写した支払先・金額と、紐づく伝票の添付の名前ぜんぶ
      payee: "架空塗装",
      amount: "352,000 円",
      linked_attachments: ["見積総覧（架空邸）.pdf", "無関係.pdf", "写真1.jpg", "御見積書（架空邸）.pdf"],
      senketsu_no: "2267",
    });
    expect(log).toContain("  ! アップロード待ちで保留にしました（御見積書（架空邸）.pdf）");

    // 一覧ではアップロード待ちの行として出る
    const [item] = await buildListItems(store, natsuin, memoryStatsCache());
    expect(item).toMatchObject({ pending: true, file: "御見積書（架空邸）.pdf", payee: "架空塗装", property_name: "架空邸", pages: 5 });
    expect(item.missing_attachments?.[0]).toMatchObject({ awaiting: true, files: [] });
  });

  it("★書類を入れて確定すると、決めた名前で保存し、部品を残す（差し替えできる）", async () => {
    const { fs, store } = await run({ scan: scanOf([target("NA00001001")]), fetch: { NA00001001: fetched() } });
    await completePending(store, natsuin, "NA00001001", { files: [{ index: 0, name: "保険金請求書.pdf", bytes: await makePdf(1, [210, 297]) }], slots: [0], acceptMissing: false }, NOW);
    expect(await pageSizes(fs.get("御見積書（架空邸）.pdf")!)).toEqual([
      [210, 297],
      [300, 300],
      [300, 300],
      [842, 595],
      [310, 310],
      [320, 320],
    ]);
    expect(fs.files().some((f) => f.startsWith("_部品/NA00001001/manifest.json"))).toBe(true);
    const records = await readRecords(store, natsuin);
    expect(records.log[0]).toMatchObject({ file: "御見積書（架空邸）.pdf", payee: "架空塗装", replaced_attachments: ["保険金請求書.pdf"] });
  });

  it("★紐づく伝票が見つからなければ、専決決裁書の本体を欠けとして残し、理由を記録に出す（名前は接頭辞＋下4桁）", async () => {
    const { store, log } = await run({
      scan: scanOf([target("NA00001001")]),
      fetch: {
        NA00001001: fetched({
          linked: null,
          compose: compose({ picked: [], paren: null, parenFrom: null, finalName: "捺印決裁書№1001.pdf", linkReason: "専決決裁書 No.2267 が専決決裁書の一覧に見つかりませんでした" }),
        }),
      },
    });
    const records = await readRecords(store, natsuin);
    expect(records.pending.NA00001001.missing).toEqual([
      { index: 0, name: "あとからアップロードする書類", reason: "あとからアップロードする書類", awaiting: true },
      { index: 1, name: "専決決裁書 本体（No.2267）", reason: "専決決裁書 No.2267 が専決決裁書の一覧に見つかりませんでした" },
    ]);
    expect(records.pending.NA00001001.meta).toMatchObject({ final_name: "捺印決裁書№1001.pdf" });
    expect(records.pending.NA00001001.meta.linked_attachments).toBeUndefined();
    expect(log).toContain("  ! 専決決裁書 No.2267 が専決決裁書の一覧に見つかりませんでした");
  });

  it("選んだ添付が取れなければ、その添付を欠けとして残す", async () => {
    const { store } = await run({
      scan: scanOf([target("NA00001001")]),
      fetch: {
        NA00001001: fetched({
          linked: linked({
            attachments: [file("linked-attachment", 1, "見積総覧（架空邸）.pdf", ".pdf", summary)],
            failures: [{ index: 3, name: "写真1.jpg", code: "ATTACHMENT_FAILED", reason: "60秒待ってもダウンロードが始まりませんでした", retryable: true }],
          }),
        }),
      },
    });
    const missing = (await readRecords(store, natsuin)).pending.NA00001001.missing;
    expect(missing.map((m) => [m.index, m.name, m.reason])).toEqual([
      [0, "あとからアップロードする書類", "あとからアップロードする書類"],
      [2, "写真1.jpg", "60秒待ってもダウンロードが始まりませんでした"],
    ]);
  });

  it("★時間の上限で取れなかった紐づく添付は、専決決裁書として1つずつ取り直す", async () => {
    const { api, fs } = await run({
      scan: scanOf([target("NA00001001")]),
      fetch: {
        NA00001001: fetched({
          linked: linked({
            attachments: [file("linked-attachment", 1, "見積総覧（架空邸）.pdf", ".pdf", summary)],
            failures: [{ index: 3, name: "写真1.jpg", code: "TIME_BUDGET_EXCEEDED", reason: "時間の上限", retryable: true }],
          }),
        }),
      },
      attachment: (request) => file("attachment", request.index, request.expectedName, ".png", makePng(4, 3)),
    });
    expect(api.calls.find((c) => c.method === "attachment")?.request).toMatchObject({
      kind: "senketsu",
      denpyoNo: "SE00002267",
      href: "https://example.test/abcd/detail?no=2267",
      index: 3,
      expectedName: "写真1.jpg",
    });
    expect(fs.files()).toContain("_保留/NA00001001/002_写真1.png");
  });

  it("組み立ての結果を受け取れなければ、理由を出して止める", async () => {
    const { status } = await run({ scan: scanOf([target("NA00001001")]), fetch: { NA00001001: fetched({ compose: null }) } });
    expect(status.state).toBe("error");
    expect(status.error).toContain("組み立ての結果を受け取れませんでした");
  });

  it("本体PDFが取れない捺印決裁書は、記録せず見送る（顛末書と同じ）", async () => {
    const { store, status } = await run({
      scan: scanOf([target("NA00001001")]),
      fetch: { NA00001001: new RakurakuApiError("BODY_PDF_FAILED", "本体PDFを取れませんでした", true) },
    });
    expect(status.skipped).toEqual(["NA00001001"]);
    expect(await readRecords(store, natsuin)).toMatchObject({ done: [], pending: {} });
  });
});
