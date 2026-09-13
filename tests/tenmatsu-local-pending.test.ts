import { describe, expect, it } from "vitest";
import { FolderError, FolderStore } from "@/lib/tenmatsu/local/fs";
import { LOCAL_KINDS } from "@/lib/tenmatsu/local/kind-config";
import {
  type Manifest,
  PendingError,
  applyUploads,
  mergeOrder,
  missingRecords,
  normalizeSlot,
  readManifest,
  recordPages,
  uploadedNames,
} from "@/lib/tenmatsu/local/manifest";
import { completePending, recomposeSaved } from "@/lib/tenmatsu/local/pending-ops";
import { appendProcessed, readRecords, registerPending, setFlags } from "@/lib/tenmatsu/local/records";
import { FakeFs } from "./helpers/fake-fs";
import { makePdf, makePng, pageSizes } from "./helpers/pdf-parts";

// 期待値は移植元 tenmatsu.py の apply_uploads / complete_pending / recompose_saved の検証（server_test.py「保留」「差し替え」）から写した

const NOW = new Date(2026, 8, 13, 10, 0, 0);
const tenmatsu = LOCAL_KINDS.tenmatsu;
const natsuin = LOCAL_KINDS.natsuin;

async function pdf(pages: number, size: [number, number]) {
  return await makePdf(pages, size);
}

async function folderError(promise: Promise<unknown>): Promise<FolderError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof FolderError) return e;
    throw e;
  }
  throw new Error("失敗するはずが、通ってしまった");
}

async function pendingError(promise: Promise<unknown>): Promise<PendingError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof PendingError) return e;
    throw e;
  }
  throw new Error("失敗するはずが、通ってしまった");
}

/** 顛末書の保留: 本体（2ページ）・結合できなかった Excel・結合できた写真 */
async function tenmatsuPending() {
  const fs = new FakeFs();
  const store = new FolderStore(fs.root);
  const manifest: Manifest = {
    denpyo_no: "TE00009106",
    kind: "tenmatsu",
    at: "2026-09-12T09:00:00",
    parts: [
      { index: 0, name: "本体", file: "000_本体.pdf", status: "ok", pages: 2 },
      { index: 1, name: "見積.xlsx", file: "001_見積.xlsx", status: "failed", reason: "Excel は結合できません" },
      { index: 2, name: "写真.png", file: "002_写真.png", status: "ok", pages: 1 },
    ],
    merged_pages: 3,
  };
  fs.put("_保留/TE00009106/000_本体.pdf", await pdf(2, [595, 842]));
  fs.put("_保留/TE00009106/001_見積.xlsx", new Uint8Array([0x50, 0x4b, 3, 4]));
  fs.put("_保留/TE00009106/002_写真.png", makePng(40, 30));
  fs.put("_保留/TE00009106/_merged.pdf", await pdf(3, [100, 100]));
  fs.put("_保留/TE00009106/manifest.json", JSON.stringify(manifest, null, 2));
  await registerPending(
    store,
    tenmatsu,
    "TE00009106",
    "TE00009106",
    [{ index: 1, name: "見積.xlsx", reason: "Excel は結合できません" }],
    { shinsei_date: "2026/09/10 11:37:00", amount: "3,300 円" },
    NOW,
  );
  return { fs, store };
}

/** 捺印決裁書の保留: [0] あとから入れる書類（空）→ 選んだ添付 → 専決決裁書の本体 → 捺印決裁書の本体 */
async function natsuinPending() {
  const fs = new FakeFs("捺印決裁書");
  const store = new FolderStore(fs.root);
  const manifest: Manifest = {
    denpyo_no: "NA00001001",
    kind: "natsuin",
    parts: [
      { index: 0, name: "あとからアップロードする書類", status: "awaiting", files: [] },
      { index: 1, name: "決定通知書.pdf", file: "001_決定通知書.pdf", status: "ok" },
      { index: 2, name: "専決決裁書の本体", file: "002_専決決裁書.pdf", status: "ok" },
      { index: 3, name: "本体", file: "003_本体.pdf", status: "ok" },
    ],
  };
  fs.put("_保留/NA00001001/001_決定通知書.pdf", await pdf(1, [300, 300]));
  fs.put("_保留/NA00001001/002_専決決裁書.pdf", await pdf(1, [310, 310]));
  fs.put("_保留/NA00001001/003_本体.pdf", await pdf(1, [320, 320]));
  fs.put("_保留/NA00001001/_merged.pdf", await pdf(3, [100, 100]));
  fs.put("_保留/NA00001001/manifest.json", JSON.stringify(manifest, null, 2));
  await registerPending(
    store,
    natsuin,
    "NA00001001",
    "NA00001001",
    [{ index: 0, name: "あとからアップロードする書類", reason: "アップロード待ち", awaiting: true }],
    { final_name: "保険金請求書（架空邸）.pdf", content: "外壁補修工事の捺印依頼" },
    NOW,
  );
  return { fs, store };
}

const newFile = (index: number, name: string, bytes: Uint8Array) => ({ index, name, bytes });

describe("manifest の並び", () => {
  it("★古い形の枠（1つだけ入る枠）も今の形として読める", () => {
    const part = { index: 0, name: "書類", status: "replaced", file: "000_申請書.pdf" };
    normalizeSlot(part);
    expect(part).toEqual({ index: 0, name: "書類", status: "uploaded", files: [{ file: "000_申請書.pdf", name: "申請書.pdf" }] });
    const empty = { index: 0, name: "書類", status: "uploaded", files: [{ file: "", name: "x" }] };
    normalizeSlot(empty);
    expect(empty.status).toBe("awaiting");
  });

  it("★顛末書（組み立てない種類）の index 0 は本体なので、枠として直さない", async () => {
    const { store } = await tenmatsuPending();
    const manifest = await readManifest(store, ["_保留", "TE00009106"], { composed: false, missing: "noFiles" });
    expect(manifest.parts[0]).toMatchObject({ status: "ok", file: "000_本体.pdf" });
  });

  it("結合する順（index 昇順・枠の中は入れた並び）。欠けと空の枠は結合しない", () => {
    expect(
      mergeOrder([
        { index: 2, name: "c", status: "ok", file: "002_c.pdf" },
        { index: 0, name: "枠", status: "uploaded", files: [{ file: "000_02_b.pdf", name: "b" }, { file: "000_01_a.pdf", name: "a" }] },
        { index: 1, name: "欠け", status: "failed", file: "001_x.xlsx" },
      ]),
    ).toEqual(["000_02_b.pdf", "000_01_a.pdf", "002_c.pdf"]);
  });

  it("★部品ごとのページ数を書き込む（枠は入れたファイルごと、枠そのものは持たない）", () => {
    const parts = [
      { index: 0, name: "枠", status: "uploaded", files: [{ file: "000_01_a.pdf", name: "a" }], pages: 9 },
      { index: 1, name: "欠け", status: "failed" },
      { index: 2, name: "本体", status: "ok", file: "002_本体.pdf" },
    ];
    recordPages(parts, ["000_01_a.pdf", "002_本体.pdf"], [3, 1]);
    expect(parts).toEqual([
      { index: 0, name: "枠", status: "uploaded", files: [{ file: "000_01_a.pdf", name: "a", pages: 3 }] },
      { index: 1, name: "欠け", status: "failed", pages: 0 },
      { index: 2, name: "本体", status: "ok", file: "002_本体.pdf", pages: 1 },
    ]);
  });
});

describe("入れたファイルを反映する", () => {
  it("★検査を全部済ませてから書く（2件目が結合できない形式なら、1件目も書かない）", async () => {
    const { fs, store } = await natsuinPending();
    const dir = ["_保留", "NA00001001"];
    const manifest = await readManifest(store, dir, { composed: true, missing: "noFiles" });
    const before = fs.files();
    const error = await pendingError(
      applyUploads(store, dir, manifest, [newFile(0, "見積.pdf", await pdf(1, [200, 200])), newFile(0, "見積.xlsx", new Uint8Array([1]))], [0]),
    );
    expect(error.kind).toBe("invalid");
    expect(error.message).toContain("手でPDFにしてから入れてください");
    expect(fs.files()).toEqual(before);
  });

  it("★枠は「望む最終状態」: 並び・残す・外すが1回で決まり、同じ名前でもぶつからない", async () => {
    const { fs, store } = await natsuinPending();
    const dir = ["_保留", "NA00001001"];
    const manifest = await readManifest(store, dir, { composed: true, missing: "noFiles" });
    await applyUploads(store, dir, manifest, [newFile(0, "請求書.pdf", await pdf(1, [201, 201])), newFile(0, "請求書.pdf", await pdf(1, [202, 202]))], [0]);
    expect(manifest.parts[0].files).toEqual([
      { file: "000_01_請求書.pdf", name: "請求書.pdf" },
      { file: "000_02_請求書.pdf", name: "請求書.pdf" },
    ]);
    // 2つ目だけ残して、前に並べ、新しい写真を後ろに足す（1つ目は外す）
    await applyUploads(store, dir, manifest, [{ index: 0, keep: "000_02_請求書.pdf" }, newFile(0, "現場.jpg", makePng(4, 3))], [0]);
    expect(manifest.parts[0].files).toEqual([
      { file: "000_02_請求書.pdf", name: "請求書.pdf" },
      // ★表示名は .jpg でも中身は PNG なので、実ファイルは .png
      { file: "000_01_現場.png", name: "現場.jpg" },
    ]);
    expect(fs.get("_保留/NA00001001/000_01_請求書.pdf")).toBeNull();
    // slots に入れて要素が無ければ、全部外して空の枠に戻る
    await applyUploads(store, dir, manifest, [], [0]);
    expect(manifest.parts[0]).toMatchObject({ status: "awaiting", files: [] });
  });

  it("枠に無いファイルを残す指定・同じファイルを2回残す指定は断る", async () => {
    const { store } = await natsuinPending();
    const dir = ["_保留", "NA00001001"];
    const manifest = await readManifest(store, dir, { composed: true, missing: "noFiles" });
    expect((await pendingError(applyUploads(store, dir, manifest, [{ index: 0, keep: "無い.pdf" }], [0]))).message).toContain("枠にありません");
    await applyUploads(store, dir, manifest, [newFile(0, "a.pdf", await pdf(1, [201, 201]))], [0]);
    const kept = manifest.parts[0].files![0].file;
    expect(
      (await pendingError(applyUploads(store, dir, manifest, [{ index: 0, keep: kept }, { index: 0, keep: kept }], [0]))).message,
    ).toContain("2回指定されています");
  });

  it("★結合できなかった添付は1つだけ入れ直せる。入れ直したあとも、また入れ直せる", async () => {
    const { fs, store } = await tenmatsuPending();
    const dir = ["_保留", "TE00009106"];
    const manifest = await readManifest(store, dir, { composed: false, missing: "noFiles" });
    await applyUploads(store, dir, manifest, [newFile(1, "見積（PDF版）.pdf", await pdf(1, [400, 400]))]);
    expect(manifest.parts[1]).toEqual({ index: 1, name: "見積.xlsx", file: "001_見積（PDF版）.pdf", status: "replaced", uploaded_name: "見積（PDF版）.pdf" });
    expect(fs.get("_保留/TE00009106/001_見積.xlsx")).toBeNull();
    await applyUploads(store, dir, manifest, [newFile(1, "見積2.pdf", await pdf(1, [401, 401]))]);
    expect(manifest.parts[1].file).toBe("001_見積2.pdf");
    expect(
      (await pendingError(applyUploads(store, dir, manifest, [newFile(1, "a.pdf", new Uint8Array([1])), newFile(1, "b.pdf", new Uint8Array([1]))]))).message,
    ).toContain("1つだけ");
  });

  it("欠けていない添付・無い番号は差し替えさせない", async () => {
    const { store } = await tenmatsuPending();
    const dir = ["_保留", "TE00009106"];
    const manifest = await readManifest(store, dir, { composed: false, missing: "noFiles" });
    expect((await pendingError(applyUploads(store, dir, manifest, [newFile(0, "a.pdf", new Uint8Array([1]))]))).message).toContain("欠けていない");
    expect((await pendingError(applyUploads(store, dir, manifest, [newFile(9, "a.pdf", new Uint8Array([1]))]))).message).toContain("9 番の添付はありません");
    expect((await pendingError(applyUploads(store, dir, manifest, [], [0]))).message).toContain("書類を並べる枠ではありません");
  });
});

describe("保留を確定する", () => {
  it("★入れた書類で結合し直して保存し、記録へ移し、保留を片付ける", async () => {
    const { fs, store } = await tenmatsuPending();
    const result = await completePending(
      store,
      tenmatsu,
      "TE00009106",
      { files: [newFile(1, "見積（PDF版）.pdf", await pdf(1, [400, 400]))], acceptMissing: false },
      NOW,
    );
    expect(result).toEqual({ savedName: "顛末書No.9106.pdf", warnings: [] });
    expect(await pageSizes(fs.get("顛末書No.9106.pdf")!)).toEqual([
      [595, 842],
      [595, 842],
      [400, 400],
      [842, 595],
    ]);
    const records = await readRecords(store, tenmatsu);
    expect(records.pending).toEqual({});
    expect(records.done).toEqual(["TE00009106"]);
    expect(records.log[0]).toEqual({
      denpyo_no: "TE00009106",
      file: "顛末書No.9106.pdf",
      at: "2026-09-13T10:00:00",
      shinsei_date: "2026/09/10 11:37:00",
      amount: "3,300 円",
      replaced_attachments: ["見積（PDF版）.pdf"],
    });
    // 顛末書は部品を残さない
    expect(fs.files().filter((f) => f.startsWith("_保留") || f.startsWith("_部品"))).toEqual([]);
  });

  it("★足りない添付があれば、欠けたまま確定する指定が無い限り断る", async () => {
    const { fs, store } = await tenmatsuPending();
    const error = await pendingError(completePending(store, tenmatsu, "TE00009106", { files: [], acceptMissing: false }, NOW));
    expect(error.message).toContain("添付 見積.xlsx が足りません");
    expect(fs.get("顛末書No.9106.pdf")).toBeNull();
  });

  it("欠けたまま確定すると、欠けた添付を記録に残す", async () => {
    const { store } = await tenmatsuPending();
    await completePending(store, tenmatsu, "TE00009106", { files: [], acceptMissing: true }, NOW);
    const log = (await readRecords(store, tenmatsu)).log[0];
    expect(log.missing_attachments).toEqual([{ index: 1, name: "見積.xlsx", reason: "Excel は結合できません" }]);
  });

  it("★結合に失敗しても、入れた分と並びは残し、保留のまま（manifest の内訳は前のまま）", async () => {
    const { fs, store } = await tenmatsuPending();
    const broken = new TextEncoder().encode("%PDF-1.4 壊れている");
    const error = await pendingError(
      completePending(store, tenmatsu, "TE00009106", { files: [newFile(1, "壊れた.pdf", broken)], acceptMissing: false }, NOW),
    );
    expect(error.kind).toBe("mergeFailed");
    expect((await readRecords(store, tenmatsu)).pending.TE00009106).toBeDefined();
    const manifest = JSON.parse(fs.text("_保留/TE00009106/manifest.json")!) as Manifest;
    expect(manifest.parts[1]).toMatchObject({ status: "replaced", file: "001_壊れた.pdf" });
    expect(manifest.parts[0].pages).toBe(2);
    expect(fs.get("_保留/TE00009106/001_壊れた.pdf")).not.toBeNull();
  });

  it("★保存先の同じ名前の PDF を開いていても上書きしない（別名で保存する）", async () => {
    const { fs, store } = await tenmatsuPending();
    fs.put("顛末書No.9106.pdf", "前からあるファイル");
    const result = await completePending(store, tenmatsu, "TE00009106", { files: [], acceptMissing: true }, NOW);
    expect(result.savedName).toBe("顛末書No.TE00009106.pdf");
    expect(fs.text("顛末書No.9106.pdf")).toBe("前からあるファイル");
  });

  it("保留になっていない伝票は確定できない", async () => {
    const { store } = await tenmatsuPending();
    expect((await pendingError(completePending(store, tenmatsu, "TE404", { files: [], acceptMissing: true }))).kind).toBe("notPending");
  });

  it("保留のファイルが無くなっていれば、取り直すよう案内する", async () => {
    const { fs, store } = await tenmatsuPending();
    await store.remove(["_保留", "TE00009106"], { recursive: true });
    expect(fs.files().some((f) => f.startsWith("_保留"))).toBe(false);
    const error = await pendingError(completePending(store, tenmatsu, "TE00009106", { files: [], acceptMissing: true }));
    expect(error.kind).toBe("noFiles");
    expect(error.message).toContain("取り消して次回取り直す");
  });

  it("★捺印決裁書: あとから入れる書類が空なら、欠けたまま確定する指定でも断る", async () => {
    const { store } = await natsuinPending();
    const error = await pendingError(completePending(store, natsuin, "NA00001001", { files: [], slots: [0], acceptMissing: true }));
    expect(error.message).toBe("あとからアップロードする書類 をアップロードしてください");
  });

  it("★捺印決裁書: 伝票ごとに決めた名前で保存し、部品を _部品 に残す（内訳つき・途中のファイルは消す）", async () => {
    const { fs, store } = await natsuinPending();
    const result = await completePending(
      store,
      natsuin,
      "NA00001001",
      { files: [newFile(0, "保険金請求書.pdf", await pdf(2, [210, 297]))], slots: [0], acceptMissing: false },
      NOW,
    );
    expect(result.savedName).toBe("保険金請求書（架空邸）.pdf");
    expect(await pageSizes(fs.get("保険金請求書（架空邸）.pdf")!)).toEqual([
      [210, 297],
      [210, 297],
      [300, 300],
      [310, 310],
      [320, 320],
    ]);
    expect(fs.files().filter((f) => f.startsWith("_"))).toEqual([
      "_記録/processed_natsuin.json",
      "_記録/processed_natsuin.json.bak",
      "_部品/NA00001001/000_01_保険金請求書.pdf",
      "_部品/NA00001001/001_決定通知書.pdf",
      "_部品/NA00001001/002_専決決裁書.pdf",
      "_部品/NA00001001/003_本体.pdf",
      "_部品/NA00001001/manifest.json",
    ]);
    const manifest = JSON.parse(fs.text("_部品/NA00001001/manifest.json")!) as Manifest;
    expect(manifest.parts[0].files).toEqual([{ file: "000_01_保険金請求書.pdf", name: "保険金請求書.pdf", pages: 2 }]);
    expect(manifest.merged_pages).toBe(5);
    expect(uploadedNames(manifest.parts)).toEqual(["保険金請求書.pdf"]);
    expect(missingRecords(manifest.parts)).toEqual([]);
  });
});

describe("確定した書類を組み直す（捺印決裁書）", () => {
  async function saved() {
    const { fs, store } = await natsuinPending();
    await completePending(
      store,
      natsuin,
      "NA00001001",
      { files: [newFile(0, "保険金請求書.pdf", await pdf(2, [210, 297]))], slots: [0], acceptMissing: false },
      NOW,
    );
    await setFlags(store, natsuin, "NA00001001", { cloud_stored: true }, NOW);
    return { fs, store };
  }

  it("★同じ名前で上書きし（_2 を付けない）、部品を入れ替え、完了の印を外す", async () => {
    const { fs, store } = await saved();
    const result = await recomposeSaved(
      store,
      natsuin,
      "NA00001001",
      [{ index: 0, keep: "000_01_保険金請求書.pdf" }, newFile(0, "追加の写真.png", makePng(3, 4))],
      [0],
      new Date(2026, 8, 14, 8, 0, 0),
    );
    expect(result).toEqual({ savedName: "保険金請求書（架空邸）.pdf", warnings: [] });
    expect(fs.files().filter((f) => f.endsWith(".pdf") && !f.startsWith("_"))).toEqual(["保険金請求書（架空邸）.pdf"]);
    expect((await pageSizes(fs.get("保険金請求書（架空邸）.pdf")!)).length).toBe(6);
    const records = await readRecords(store, natsuin);
    expect(records.flags).toEqual({});
    const last = records.log.at(-1)!;
    expect(last).toMatchObject({
      file: "保険金請求書（架空邸）.pdf",
      replaced_attachments: ["保険金請求書.pdf", "追加の写真.png"],
      recomposed_at: "2026-09-14T08:00:00",
    });
    expect(fs.files().filter((f) => f.startsWith("_部品"))).toContain("_部品/NA00001001/000_01_追加の写真.png");
    expect(fs.files().some((f) => f.startsWith("_work"))).toBe(false);
  });

  it("★失敗したら、保存先の PDF も部品も元のまま（作業フォルダーは片付ける）", async () => {
    const { fs, store } = await saved();
    const before = fs.files().map((f) => [f, fs.text(f)]);
    const error = await pendingError(recomposeSaved(store, natsuin, "NA00001001", [newFile(0, "壊れた.pdf", new TextEncoder().encode("壊れている"))], [0]));
    expect(error.kind).toBe("mergeFailed");
    expect(fs.files().map((f) => [f, fs.text(f)])).toEqual(before);
  });

  it("★保存先の PDF を開いていて上書きできなければ、開いているアプリを閉じるよう案内し、元のまま", async () => {
    const { fs, store } = await saved();
    fs.lock("保険金請求書（架空邸）.pdf");
    const before = fs.files();
    const error = await folderError(recomposeSaved(store, natsuin, "NA00001001", [{ index: 0, keep: "000_01_保険金請求書.pdf" }], [0]));
    expect(error.kind).toBe("conflict");
    expect(fs.files()).toEqual(before);
    expect((await readRecords(store, natsuin)).flags.NA00001001).toBeDefined();
  });

  it("保留中・記録が無い・部品が無い・差し替えできない種類は断る", async () => {
    const pending = await natsuinPending();
    expect((await pendingError(recomposeSaved(pending.store, natsuin, "NA00001001", [], [0]))).message).toContain("保留中です");
    const { fs, store } = await saved();
    expect((await pendingError(recomposeSaved(store, natsuin, "NA404", [], [0]))).kind).toBe("notSaved");
    await store.remove(["_部品", "NA00001001"], { recursive: true });
    expect((await pendingError(recomposeSaved(store, natsuin, "NA00001001", [], [0]))).kind).toBe("noParts");
    expect(fs.files().some((f) => f.startsWith("_work"))).toBe(false);
    const t = new FolderStore(new FakeFs().root);
    await appendProcessed(t, tenmatsu, "TE1", "a.pdf", null);
    expect((await pendingError(recomposeSaved(t, tenmatsu, "TE1", [], []))).message).toContain("差し替えに対応していません");
  });
});
