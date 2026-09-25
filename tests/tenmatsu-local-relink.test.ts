import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TenmatsuError } from "@/lib/tenmatsu/client";
import { createLocalFolderClient, resetActiveRun } from "@/lib/tenmatsu/local/client";
import { createHashMemo, fingerprintOf, nameKey, readFingerprint, sha256Hex } from "@/lib/tenmatsu/local/fingerprint";
import { FolderStore, type Path } from "@/lib/tenmatsu/local/fs";
import { mergeRecords } from "@/lib/tenmatsu/local/import";
import { LOCAL_KINDS } from "@/lib/tenmatsu/local/kind-config";
import { PendingError } from "@/lib/tenmatsu/local/manifest";
import { decideOutputName } from "@/lib/tenmatsu/local/naming";
import { planPrefixRenames, renamePrefix } from "@/lib/tenmatsu/local/relink";
import { completePending, recomposeSaved } from "@/lib/tenmatsu/local/pending-ops";
import {
  appendProcessed,
  claimedNames,
  latestEntries,
  readRecords,
  recordsPath,
  registerPending,
} from "@/lib/tenmatsu/local/records";
import type { Manifest } from "@/lib/tenmatsu/local/manifest";
import { FakeFs } from "./helpers/fake-fs";
import { createFakeApi } from "./helpers/fake-rakuraku-api";
import { makePdf } from "./helpers/pdf-parts";

const NOW = new Date(2026, 8, 14, 12, 0, 0);
const tenmatsu = LOCAL_KINDS.tenmatsu;
const natsuin = LOCAL_KINDS.natsuin;
const PYTHON_SAMPLE = readFileSync(new URL("./tenmatsu-local/processed_python.json", import.meta.url), "utf-8");

beforeEach(() => resetActiveRun());
afterEach(() => resetActiveRun());

/** 読んだファイルを数える FolderStore（大きさが違う候補を読まないことを確かめる） */
class CountingStore extends FolderStore {
  reads: string[] = [];
  override async readBytes(path: Path): Promise<Uint8Array> {
    this.reads.push(path.join("/"));
    return await super.readBytes(path);
  }
}

function setup(kind: "tenmatsu" | "natsuin" = "tenmatsu", fs = new FakeFs(kind === "tenmatsu" ? "顛末書" : "捺印決裁書")) {
  const store = new CountingStore(fs.root);
  const client = createLocalFolderClient({
    kind,
    store,
    api: createFakeApi({}),
    auth: { token: () => "token-0", setToken: () => undefined, login: async () => "token-0" },
    deptCode: () => null,
    now: () => NOW,
    sleep: async () => undefined,
  });
  return { fs, store, client };
}

/** 保存したことにする（PDFを置いて記録する）。fingerprint=false は以前の記録（指紋なし） */
async function save(fs: FakeFs, store: FolderStore, no: string, name: string, bytes: Uint8Array, fingerprint = true) {
  fs.put(name, bytes);
  await appendProcessed(store, tenmatsu, no, name, null, NOW, fingerprint ? await fingerprintOf(bytes) : undefined);
}

/** PCで名前を変えたことにする */
async function rename(fs: FakeFs, store: FolderStore, from: string, to: string) {
  fs.put(to, fs.get(from)!);
  await store.remove([from]);
}

async function failure(promise: Promise<unknown>): Promise<TenmatsuError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof TenmatsuError) return e;
    throw e;
  }
  throw new Error("失敗するはずが、通ってしまった");
}

describe("指紋", () => {
  it("SHA-256 は既知の値と一致し、記録の形が崩れていれば読まない", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(readFingerprint({ pdf_size: 3, pdf_sha256: "x" })).toBeNull();
    expect(readFingerprint({ pdf_size: -1, pdf_sha256: "a".repeat(64) })).toBeNull();
    expect(readFingerprint({ pdf_size: 3, pdf_sha256: "a".repeat(64) })).toEqual({ pdf_size: 3, pdf_sha256: "a".repeat(64) });
  });

  it("名前の比べ方は大文字・小文字と濁点の分け方の違いを同じとみなす", () => {
    expect(nameKey("顛末書№1476.PDF")).toBe(nameKey("顛末書№1476.pdf"));
    expect(nameKey("ガス.pdf")).toBe(nameKey("ガス.pdf"));
  });
});

describe("名前を変えたPDFを中身で結び直す", () => {
  it("★名前を変えても一覧で「取得済み」に戻り、記録の名前が今の名前になる", async () => {
    const { fs, store, client } = setup();
    await save(fs, store, "TE00001476", "顛末書№1476.pdf", await makePdf(2));
    await rename(fs, store, "顛末書№1476.pdf", "顛末書№1476_架空邸 外壁.pdf");

    const { items, relinked } = await client.listWithRelinks();
    expect(relinked).toEqual([{ denpyoNo: "TE00001476", from: "顛末書№1476.pdf", to: "顛末書№1476_架空邸 外壁.pdf" }]);
    expect(items[0]).toMatchObject({ file: "顛末書№1476_架空邸 外壁.pdf", exists: true, pages: 2 });
    const entry = latestEntries(await readRecords(store, tenmatsu)).get("TE00001476")!;
    expect(entry).toMatchObject({
      file: "顛末書№1476_架空邸 外壁.pdf",
      relinked_from: "顛末書№1476.pdf",
      relinked_at: "2026-09-14T12:00:00",
    });
    // プレビューも今の名前から読める
    const blob = await client.filePdf("TE00001476");
    expect(blob.size).toBe(fs.get("顛末書№1476_架空邸 外壁.pdf")!.byteLength);
  });

  it("★結び直したあとの一覧は何も書かない（控えを無駄に上書きしない）", async () => {
    const { fs, store, client } = setup();
    await save(fs, store, "TE00001476", "顛末書№1476.pdf", await makePdf(1));
    await rename(fs, store, "顛末書№1476.pdf", "外壁.pdf");
    await client.list();
    const writes = fs.writes.length;
    await client.list();
    await client.backfillFingerprints();
    expect(fs.writes.length).toBe(writes);
  });

  it("★同じ中身のPDFが2つあれば結ばない（推測しない）", async () => {
    const { fs, store, client } = setup();
    const bytes = await makePdf(1);
    await save(fs, store, "TE00001476", "顛末書№1476.pdf", bytes);
    await rename(fs, store, "顛末書№1476.pdf", "コピーA.pdf");
    fs.put("コピーB.pdf", bytes);
    const before = fs.text(recordsPath(tenmatsu).join("/"));
    const { items, relinked } = await client.listWithRelinks();
    expect(relinked).toEqual([]);
    expect(items[0].exists).toBe(false);
    expect(fs.text(recordsPath(tenmatsu).join("/"))).toBe(before);
    const candidates = await client.relinkCandidates("TE00001476");
    expect(candidates.filter((c) => c.sameContent === true).map((c) => c.name).sort()).toEqual(["コピーA.pdf", "コピーB.pdf"]);
  });

  it("★ほかの記録が使っているPDFは候補にしない", async () => {
    const { fs, store, client } = setup();
    const bytes = await makePdf(1);
    await save(fs, store, "TE00001000", "顛末書№1000.pdf", bytes);
    // 同じ中身を別の伝票として記録し、そのPDFを消す
    await appendProcessed(store, tenmatsu, "TE00002000", "顛末書№2000.pdf", null, NOW, await fingerprintOf(bytes));
    const { relinked } = await client.listWithRelinks();
    expect(relinked).toEqual([]);
    expect((await client.relinkCandidates("TE00002000")).map((c) => c.name)).toEqual([]);
  });

  it("大きさが違うPDFは中身を読まない（速さのため）", async () => {
    const { fs, store, client } = setup();
    await save(fs, store, "TE00001476", "顛末書№1476.pdf", await makePdf(1));
    await store.remove(["顛末書№1476.pdf"]);
    fs.put("関係ない.pdf", await makePdf(3, [300, 300]));
    store.reads = [];
    await client.listWithRelinks();
    expect(store.reads.filter((r) => r === "関係ない.pdf")).toEqual([]);
  });

  it("フォルダーの中（_保留 など）とPDF以外は探さない", async () => {
    const { fs, store, client } = setup();
    const bytes = await makePdf(1);
    await save(fs, store, "TE00001476", "顛末書№1476.pdf", bytes);
    await store.remove(["顛末書№1476.pdf"]);
    fs.put("_部品/TE00001476/000_本体.pdf", bytes);
    fs.put("控え.PDF.txt", bytes);
    expect((await client.listWithRelinks()).relinked).toEqual([]);
  });

  it("指紋の無い以前の記録は自動では結ばない（手で選び直す）", async () => {
    const { fs, store, client } = setup();
    await save(fs, store, "TE00001476", "顛末書№1476.pdf", await makePdf(1), false);
    await rename(fs, store, "顛末書№1476.pdf", "外壁.pdf");
    const { items, relinked } = await client.listWithRelinks();
    expect(relinked).toEqual([]);
    expect(items[0].exists).toBe(false);
  });
});

describe("以前の記録に指紋を後から付ける", () => {
  it("★PDFがある記録に1回だけ書き、2回目は何も書かない", async () => {
    const { fs, store, client } = setup();
    const a = await makePdf(1);
    const b = await makePdf(2);
    await save(fs, store, "TE00001001", "顛末書№1001.pdf", a, false);
    await save(fs, store, "TE00001002", "顛末書№1002.pdf", b, false);
    await client.list();
    const first = await client.backfillFingerprints();
    expect(first).toEqual({ written: 2, remaining: 0 });
    const latest = latestEntries(await readRecords(store, tenmatsu));
    expect(readFingerprint(latest.get("TE00001001"))).toEqual(await fingerprintOf(a));
    expect(readFingerprint(latest.get("TE00001002"))).toEqual(await fingerprintOf(b));
    // キーの順は 記録の項目 → 指紋
    expect(Object.keys(latest.get("TE00001001")!)).toEqual(["denpyo_no", "file", "at", "pdf_size", "pdf_sha256"]);

    const writes = fs.writes.length;
    await client.list();
    expect(await client.backfillFingerprints()).toEqual({ written: 0, remaining: 0 });
    expect(fs.writes.length).toBe(writes);

    // 付けたあとなら、名前を変えても自動で結び直る
    await rename(fs, store, "顛末書№1001.pdf", "名前を変えた.pdf");
    expect((await client.listWithRelinks()).relinked.map((r) => r.to)).toEqual(["名前を変えた.pdf"]);
  });

  it("移植元（Python）の記録で、PDFが無ければ何も書かない", async () => {
    const { fs, client } = setup();
    fs.put("_記録/processed.json", PYTHON_SAMPLE);
    await client.list();
    await client.backfillFingerprints();
    expect(fs.text("_記録/processed.json")).toBe(PYTHON_SAMPLE);
    expect(fs.get("_記録/processed.json.bak")).toBeNull();
  });
});

describe("手で選び直す", () => {
  it("★選べるのはどの記録にも使われていない直下のPDF。選ぶと記録の名前と指紋が変わる", async () => {
    const { fs, store, client } = setup();
    const bytes = await makePdf(1);
    await save(fs, store, "TE00001476", "顛末書№1476.pdf", bytes, false);
    await save(fs, store, "TE00001477", "顛末書№1477.pdf", await makePdf(2));
    await rename(fs, store, "顛末書№1476.pdf", "外壁（架空邸）.pdf");

    const candidates = await client.relinkCandidates("TE00001476");
    expect(candidates.map((c) => [c.name, c.sameContent])).toEqual([["外壁（架空邸）.pdf", null]]);

    const item = await client.relinkFile("TE00001476", "外壁（架空邸）.pdf");
    expect(item).toMatchObject({ file: "外壁（架空邸）.pdf", exists: true });
    const entry = latestEntries(await readRecords(store, tenmatsu)).get("TE00001476")!;
    expect(entry.relinked_from).toBe("顛末書№1476.pdf");
    expect(readFingerprint(entry)).toEqual(await fingerprintOf(bytes));
  });

  it("ほかの記録のPDF・無いPDF・PDFがある記録・フォルダーの中は断る", async () => {
    const { fs, store, client } = setup();
    await save(fs, store, "TE00001476", "顛末書№1476.pdf", await makePdf(1), false);
    await save(fs, store, "TE00001477", "顛末書№1477.pdf", await makePdf(2));
    await store.remove(["顛末書№1476.pdf"]);

    expect((await failure(client.relinkFile("TE00001476", "顛末書№1477.pdf"))).kind).toBe("conflict");
    expect((await failure(client.relinkFile("TE00001476", "無い.pdf"))).kind).toBe("notFound");
    expect((await failure(client.relinkFile("TE00001477", "顛末書№1477.pdf"))).kind).toBe("conflict");
    expect((await failure(client.relinkFile("TE00001476", "_部品/x.pdf"))).kind).toBe("badRequest");
    expect((await failure(client.relinkFile("TE00001476", "メモ.txt"))).kind).toBe("badRequest");
  });

  it("見つからないPDFはプレビューで開かない", async () => {
    const { fs, store, client } = setup();
    await save(fs, store, "TE00001476", "顛末書№1476.pdf", await makePdf(1), false);
    await store.remove(["顛末書№1476.pdf"]);
    const error = await failure(client.filePdf("TE00001476"));
    expect(error.kind).toBe("notFound");
    expect(error.message).toContain("PDFを選ぶ");
  });
});

describe("名前を変えて空いた名前を、別の伝票に使わない", () => {
  it("★ほかの記録が指している名前は、ファイルが無くても保存名にしない", async () => {
    const fs = new FakeFs();
    const store = new FolderStore(fs.root);
    await save(fs, store, "TE00001476", "顛末書№1476.pdf", await makePdf(1), false);
    await rename(fs, store, "顛末書№1476.pdf", "外壁.pdf");
    const reserved = claimedNames(await readRecords(store, tenmatsu), tenmatsu);
    // 下4桁が同じ別の伝票
    expect(await decideOutputName(store, [], "TE00011476", tenmatsu.filePrefix, reserved)).toBe("顛末書№TE00011476.pdf");
    expect(await decideOutputName(store, [], "TE00011476", tenmatsu.filePrefix)).toBe("顛末書№1476.pdf");
  });
});

describe("差し替え（捺印決裁書）", () => {
  async function savedNatsuin() {
    const fs = new FakeFs("捺印決裁書");
    const store = new FolderStore(fs.root);
    const manifest: Manifest = {
      denpyo_no: "NA00001001",
      kind: "natsuin",
      parts: [
        { index: 0, name: "あとからアップロードする書類", status: "awaiting", files: [] },
        { index: 1, name: "専決決裁書の本体", file: "001_専決決裁書.pdf", status: "ok" },
        { index: 2, name: "本体", file: "002_本体.pdf", status: "ok" },
      ],
    };
    fs.put("_保留/NA00001001/001_専決決裁書.pdf", await makePdf(1, [310, 310]));
    fs.put("_保留/NA00001001/002_本体.pdf", await makePdf(1, [320, 320]));
    fs.put("_保留/NA00001001/_merged.pdf", await makePdf(2, [100, 100]));
    fs.put("_保留/NA00001001/manifest.json", JSON.stringify(manifest, null, 2));
    await registerPending(
      store,
      natsuin,
      "NA00001001",
      "NA00001001",
      [{ index: 0, name: "あとからアップロードする書類", reason: "アップロード待ち", awaiting: true }],
      { final_name: "保険金請求書（架空邸）.pdf" },
      NOW,
    );
    const upload = { index: 0, name: "請求書.pdf", bytes: await makePdf(1, [210, 297]) };
    await completePending(store, natsuin, "NA00001001", { files: [upload], slots: [0], acceptMissing: false }, NOW);
    return { fs, store };
  }

  it("確定したときも指紋を残す", async () => {
    const { fs, store } = await savedNatsuin();
    const entry = latestEntries(await readRecords(store, natsuin)).get("NA00001001")!;
    expect(readFingerprint(entry)).toEqual(await fingerprintOf(fs.get("保険金請求書（架空邸）.pdf")!));
  });

  it("★記録の名前のPDFが無ければ書かずに止まる（元の名前で新しいファイルを作らない）", async () => {
    const { fs, store } = await savedNatsuin();
    await rename(fs, store, "保険金請求書（架空邸）.pdf", "請求書_架空邸_提出用.pdf");
    const before = fs.files();
    let error: unknown = null;
    try {
      await recomposeSaved(store, natsuin, "NA00001001", [{ index: 0, keep: "000_01_請求書.pdf" }], [0], NOW);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PendingError);
    expect((error as PendingError).kind).toBe("fileMissing");
    expect(fs.files()).toEqual(before);
  });

  it("★結び直したあとは、名前を変えたファイルを上書きし、指紋も新しくなる", async () => {
    const { fs, store } = await savedNatsuin();
    const oldFingerprint = await fingerprintOf(fs.get("保険金請求書（架空邸）.pdf")!);
    await rename(fs, store, "保険金請求書（架空邸）.pdf", "請求書_架空邸_提出用.pdf");
    const { client } = setup("natsuin", fs);
    expect((await client.listWithRelinks()).relinked.map((r) => r.to)).toEqual(["請求書_架空邸_提出用.pdf"]);

    const result = await recomposeSaved(
      store,
      natsuin,
      "NA00001001",
      [{ index: 0, keep: "000_01_請求書.pdf" }, { index: 0, name: "追加.pdf", bytes: await makePdf(1, [200, 200]) }],
      [0],
      NOW,
    );
    expect(result.savedName).toBe("請求書_架空邸_提出用.pdf");
    expect(fs.files().filter((f) => f.endsWith(".pdf") && !f.startsWith("_"))).toEqual(["請求書_架空邸_提出用.pdf"]);
    const entry = latestEntries(await readRecords(store, natsuin)).get("NA00001001")!;
    const fresh = readFingerprint(entry)!;
    expect(fresh).toEqual(await fingerprintOf(fs.get("請求書_架空邸_提出用.pdf")!));
    expect(fresh.pdf_sha256).not.toBe(oldFingerprint.pdf_sha256);
  });
});

describe("取り込みとの整合", () => {
  it("結び直したあとに同じ記録を取り込み直しても、元の名前の行は増えない", async () => {
    const current = {
      done: ["TE00001476"],
      log: [{ denpyo_no: "TE00001476", file: "外壁.pdf", at: "2026-09-13T10:00:00", relinked_from: "顛末書№1476.pdf" }],
      flags: {},
      pending: {},
    };
    const incoming = {
      done: ["TE00001476"],
      log: [{ denpyo_no: "TE00001476", file: "顛末書№1476.pdf", at: "2026-09-13T10:00:00" }],
      flags: {},
      pending: {},
    };
    const { merged } = mergeRecords(current, incoming, () => false);
    expect(merged.log.map((e) => e.file)).toEqual(["外壁.pdf"]);
  });
});

describe("ハッシュの覚え書き", () => {
  it("同じ名前・大きさ・更新日時なら読み直さない", async () => {
    const fs = new FakeFs();
    const store = new CountingStore(fs.root);
    fs.put("a.pdf", await makePdf(1));
    const stat = (await store.stat(["a.pdf"]))!;
    const memo = createHashMemo();
    const file = { name: "a.pdf", size: stat.size, lastModified: stat.lastModified };
    const first = await memo.hash(store, file);
    await memo.hash(store, file);
    expect(store.reads).toEqual(["a.pdf"]);
    expect(first).toBe(await sha256Hex(fs.get("a.pdf")!));
  });
});

describe("以前の保存名（No.）を、いまの表記（№）に直す", () => {
  it("★PDFの名前と記録をまとめて直す（中身と印はそのまま）", async () => {
    const { fs, store, client } = setup();
    const bytes = await makePdf(1);
    fs.put("顛末書No.1476.pdf", bytes);
    await appendProcessed(store, tenmatsu, "TE00001476", "顛末書No.1476.pdf", null, NOW, await fingerprintOf(bytes));

    expect(planPrefixRenames(await readRecords(store, tenmatsu), tenmatsu)).toEqual([
      { denpyoNo: "TE00001476", from: "顛末書No.1476.pdf", to: "顛末書№1476.pdf" },
    ]);

    const result = await client.renameLegacyNames();
    expect(result).toEqual({ renamed: 1, skipped: [] });
    expect(fs.files().filter((f) => f.endsWith(".pdf"))).toEqual(["顛末書№1476.pdf"]);
    expect(fs.get("顛末書№1476.pdf")).toEqual(bytes);
    const entry = latestEntries(await readRecords(store, tenmatsu)).get("TE00001476")!;
    expect(entry).toMatchObject({ file: "顛末書№1476.pdf", relinked_from: "顛末書No.1476.pdf" });
    // 中身は変わっていないので指紋はそのまま
    expect(readFingerprint(entry)).toEqual(await fingerprintOf(bytes));
    expect((await client.list())[0]).toMatchObject({ file: "顛末書№1476.pdf", exists: true });
  });

  it("新しい名前のPDFがすでにあるもの・PDFが無い記録は触らない", async () => {
    const { fs, store, client } = setup();
    const a = await makePdf(1);
    fs.put("顛末書No.1476.pdf", a);
    fs.put("顛末書№1476.pdf", await makePdf(2));
    await appendProcessed(store, tenmatsu, "TE00001476", "顛末書No.1476.pdf", null, NOW, await fingerprintOf(a));
    // PDFが無い記録（以前の名前のまま）
    await appendProcessed(store, tenmatsu, "TE00001477", "顛末書No.1477.pdf", null, NOW);

    const result = await client.renameLegacyNames();
    expect(result.renamed).toBe(0);
    expect(result.skipped.map((x) => x.denpyoNo).sort()).toEqual(["TE00001476", "TE00001477"]);
    expect(fs.get("顛末書No.1476.pdf")).toEqual(a);
    expect(latestEntries(await readRecords(store, tenmatsu)).get("TE00001476")!.file).toBe("顛末書No.1476.pdf");
  });

  it("すでに「№」の名前なら何もしない", async () => {
    const { fs, store, client } = setup();
    const bytes = await makePdf(1);
    fs.put("顛末書№1476.pdf", bytes);
    await appendProcessed(store, tenmatsu, "TE00001476", "顛末書№1476.pdf", null, NOW, await fingerprintOf(bytes));
    const writes = fs.writes.length;
    expect(await client.renameLegacyNames()).toEqual({ renamed: 0, skipped: [] });
    expect(fs.writes.length).toBe(writes);
  });
});
