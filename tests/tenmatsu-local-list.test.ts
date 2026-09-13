import { describe, expect, it } from "vitest";
import { isListItemLike } from "@/lib/tenmatsu/client";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import { LOCAL_KINDS } from "@/lib/tenmatsu/local/kind-config";
import { type StatsCache, buildListItems, memoryStatsCache, pdfStats } from "@/lib/tenmatsu/local/list";
import type { Manifest } from "@/lib/tenmatsu/local/manifest";
import { appendProcessed, registerPending, setFlags } from "@/lib/tenmatsu/local/records";
import { FakeFs } from "./helpers/fake-fs";
import { makePdf } from "./helpers/pdf-parts";

// 期待値は移植元 tenmatsu.py の list_processed_files の検証（server_test.py「一覧」）から写した。すべて架空の値

const tenmatsu = LOCAL_KINDS.tenmatsu;
const at = (day: number, hour = 9) => new Date(2026, 8, day, hour, 0, 0);

function setup(name = "顛末書") {
  const fs = new FakeFs(name);
  return { fs, store: new FolderStore(fs.root), cache: memoryStatsCache() };
}

describe("一覧を組み立てる（顛末書）", () => {
  it("記録が無ければ空", async () => {
    const { store, cache } = setup();
    expect(await buildListItems(store, tenmatsu, cache)).toEqual([]);
  });

  it("★保留中（新しい順）→ 保存済み（記録に足した順の逆）。どの行も画面が受け取れる形", async () => {
    const { fs, store, cache } = setup();
    fs.put("顛末書No.0001.pdf", await makePdf(3));
    await appendProcessed(store, tenmatsu, "TE00000001", "顛末書No.0001.pdf", { amount: "1,100 円", where: "注文受注物件：架空台1丁目A号棟\u3000施主名：架空\u3000太郎\u3000監督：架空\u3000一郎/営業：架空\u3000二郎", pj: "9901230101" }, at(1));
    await appendProcessed(store, tenmatsu, "TE00000002", "顛末書No.0002.pdf", null, at(2));
    await registerPending(store, tenmatsu, "TE00000003", "TE00000003", [{ index: 1, name: "見積.xlsx", reason: "結合できません" }], { amount: "3,300 円" }, at(3));
    await registerPending(store, tenmatsu, "TE00000004", "TE00000004", [{ index: 2, name: "壊れた.pdf", reason: "取れません" }], null, at(4));
    fs.put("_保留/TE00000004/_merged.pdf", await makePdf(1));

    const items = await buildListItems(store, tenmatsu, cache);
    expect(items.map((i) => [i.denpyo_no, i.pending])).toEqual([
      ["TE00000004", true],
      ["TE00000003", true],
      ["TE00000002", false],
      ["TE00000001", false],
    ]);
    expect(items.every(isListItemLike)).toBe(true);
    // 同じキーを全部持つ
    expect(Object.keys(items[0]).sort()).toEqual(expect.arrayContaining(Object.keys(items[3]).filter((k) => k !== "pdf_layout").sort()));

    const first = items[3];
    expect(first).toMatchObject({
      file: "顛末書No.0001.pdf",
      at: "2026-09-01T09:00:00",
      exists: true,
      pages: 3,
      budget_entered: false,
      cloud_stored: false,
      completed: false,
      amount: "1,100 円",
      pj: "9901230101",
      property_name: "架空台1丁目A号棟",
      supervisor: "架空 一郎",
      sales_rep: "架空 二郎",
      pending: false,
    });
    // ★記録はあるがファイルが消えている行も隠さない
    expect(items[2]).toMatchObject({ file: "顛末書No.0002.pdf", exists: false, pages: null, size: null });
    // 保留の行は確定したときに付く予定の名前と、途中の PDF の状態
    expect(items[0]).toMatchObject({ file: "顛末書No.0004.pdf", exists: true, pages: 1, pending: true, missing_attachments: [{ index: 2, name: "壊れた.pdf", reason: "取れません" }] });
  });

  it("完了の印は保存済みの行だけ。全部そろったら completed", async () => {
    const { store, cache } = setup();
    await appendProcessed(store, tenmatsu, "TE1", "a.pdf", null, at(1));
    await setFlags(store, tenmatsu, "TE1", { budget_entered: true, cloud_stored: true }, at(2));
    const [item] = await buildListItems(store, tenmatsu, cache);
    expect(item).toMatchObject({ budget_entered: true, cloud_stored: true, completed: true, flags_updated_at: "2026-09-02T09:00:00" });
  });

  it("同じ伝票が2回記録されていたら、最後の記録を使う", async () => {
    const { store, cache } = setup();
    await appendProcessed(store, tenmatsu, "TE1", "古い.pdf", null, at(1));
    await appendProcessed(store, tenmatsu, "TE1", "新しい.pdf", null, at(2));
    const items = await buildListItems(store, tenmatsu, cache);
    expect(items.map((i) => i.file)).toEqual(["新しい.pdf"]);
  });

  it("★保留の欠けは記録の写しではなく、いまの manifest から作る（入れ直したが結合できなかった枠も出す）", async () => {
    const { fs, store, cache } = setup();
    await registerPending(store, tenmatsu, "TE1", "TE1", [{ index: 1, name: "見積.xlsx", reason: "結合できません" }], null, at(1));
    const manifest: Manifest = {
      parts: [
        { index: 0, name: "本体", status: "ok", file: "000_本体.pdf", pages: 1 },
        { index: 1, name: "見積.xlsx", status: "replaced", file: "001_見積.pdf", uploaded_name: "見積.pdf" },
      ],
      merged_pages: 1,
    };
    fs.put("_保留/TE1/manifest.json", JSON.stringify(manifest));
    fs.put("_保留/TE1/001_見積.pdf", "12345");
    const [item] = await buildListItems(store, tenmatsu, cache);
    expect(item.missing_attachments).toEqual([
      { index: 1, name: "見積.xlsx", reason: "入れ直したファイルが入っています（このまま確定するか、別のファイルを選べます）", filled: { name: "見積.pdf", size: 5 } },
    ]);
  });
});

describe("一覧を組み立てる（専決決裁書・捺印決裁書）", () => {
  it("★専決決裁書は表題と「内容」からの物件名。どこで・監督・営業・PJ はキーごと持たない", async () => {
    const { store, cache } = setup("専決決裁書");
    await appendProcessed(store, LOCAL_KINDS.senketsu, "SE1", "専決決裁書No.0001.pdf", { title: "外壁補修工事の発注", content: "物件名：架空台2丁目B号棟\u3000工事内容：外壁の補修", payee: "架空塗装" }, at(1));
    const [item] = await buildListItems(store, LOCAL_KINDS.senketsu, cache);
    expect(item).toMatchObject({ title: "外壁補修工事の発注", property_name: "架空台2丁目B号棟", payee: "架空塗装" });
    expect("pj" in item || "supervisor" in item).toBe(false);
    expect("budget_entered" in item).toBe(false);
  });

  it("★捺印決裁書は「備考」からの物件名と、差し替えのための枠・内訳を持つ", async () => {
    const { fs, store, cache } = setup("捺印決裁書");
    const natsuin = LOCAL_KINDS.natsuin;
    await appendProcessed(store, natsuin, "NA1", "保険金請求書（架空邸）.pdf", { content: "外壁補修工事の捺印依頼", senketsu_no: "2267", remarks: "物件情報 物件名：架空邸 施主名：架空 太郎" }, at(1));
    fs.put("保険金請求書（架空邸）.pdf", await makePdf(3));
    const manifest: Manifest = {
      parts: [
        { index: 0, name: "あとからアップロードする書類", status: "uploaded", files: [{ file: "000_01_請求書.pdf", name: "請求書.pdf", pages: 2 }] },
        { index: 1, name: "本体", status: "ok", file: "001_本体.pdf", pages: 1 },
      ],
      merged_pages: 3,
    };
    fs.put("_部品/NA1/manifest.json", JSON.stringify(manifest));
    fs.put("_部品/NA1/000_01_請求書.pdf", "1234");
    const [item] = await buildListItems(store, natsuin, cache);
    expect(item).toMatchObject({ content: "外壁補修工事の捺印依頼", senketsu_no: "2267", property_name: "架空邸" });
    expect(item.upload_slots).toEqual([{ index: 0, name: "あとからアップロードする書類", files: [{ file: "000_01_請求書.pdf", name: "請求書.pdf", size: 4, pages: 2 }] }]);
    expect(item.pdf_layout).toEqual([
      { index: 0, name: "請求書.pdf", file: "000_01_請求書.pdf", pages: 2 },
      { index: 1, name: "本体", pages: 1 },
    ]);
  });

  it("★内訳の合計が実物のページ数と合わなければ内訳を出さない（推測しない）。部品が無ければ枠は null", async () => {
    const { fs, store, cache } = setup("捺印決裁書");
    const natsuin = LOCAL_KINDS.natsuin;
    await appendProcessed(store, natsuin, "NA1", "a.pdf", null, at(1));
    await appendProcessed(store, natsuin, "NA2", "b.pdf", null, at(1));
    fs.put("a.pdf", await makePdf(5));
    fs.put("_部品/NA1/manifest.json", JSON.stringify({ parts: [{ index: 0, name: "本体", status: "ok", file: "x.pdf", pages: 1 }], merged_pages: 1 }));
    const items = await buildListItems(store, natsuin, cache);
    const one = items.find((i) => i.denpyo_no === "NA1")!;
    const two = items.find((i) => i.denpyo_no === "NA2")!;
    expect(one.pdf_layout).toBeNull();
    expect(two.upload_slots).toBeNull();
    expect(two.pdf_layout).toBeNull();
  });
});

describe("PDF のページ数の控え", () => {
  it("★大きさと更新日時が同じ間は数え直さない。書き換わったら数え直す", async () => {
    const { fs, store } = setup();
    fs.put("a.pdf", await makePdf(2));
    const seen: string[] = [];
    const base = memoryStatsCache();
    const cache: StatsCache = {
      get: async (key) => base.get(key),
      set: async (key, pages) => {
        seen.push(key);
        await base.set(key, pages);
      },
    };
    expect((await pdfStats(store, ["a.pdf"], cache)).pages).toBe(2);
    expect((await pdfStats(store, ["a.pdf"], cache)).pages).toBe(2);
    expect(seen).toHaveLength(1);
    await store.writeBytes(["a.pdf"], await makePdf(4));
    expect((await pdfStats(store, ["a.pdf"], cache)).pages).toBe(4);
    expect(seen).toHaveLength(2);
  });

  it("読めない PDF のページ数は null（0 にしない）", async () => {
    const { fs, store, cache } = setup();
    fs.put("壊れた.pdf", "PDFではない");
    expect(await pdfStats(store, ["壊れた.pdf"], cache)).toEqual({ exists: true, pages: null, size: new TextEncoder().encode("PDFではない").length });
  });
});
