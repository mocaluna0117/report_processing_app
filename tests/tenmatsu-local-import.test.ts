import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import { ImportError, importNameWarning, importRecords, mergeRecords, parseProcessedJson, previewImport } from "@/lib/tenmatsu/local/import";
import { LOCAL_KINDS } from "@/lib/tenmatsu/local/kind-config";
import { buildListItems, memoryStatsCache } from "@/lib/tenmatsu/local/list";
import { type ProcessedData, appendProcessed, formatRecords, readRecords, registerPending, setFlags } from "@/lib/tenmatsu/local/records";
import { FakeFs } from "./helpers/fake-fs";

/** 旧ツール（Python）が書いた記録の見本。架空の値だけ（2件保存済み・1件保留・印1つ・知らない項目1つ） */
const PYTHON_SAMPLE = readFileSync(new URL("./tenmatsu-local/processed_python.json", import.meta.url), "utf-8");
const tenmatsu = LOCAL_KINDS.tenmatsu;

function setup() {
  const fs = new FakeFs();
  return { fs, store: new FolderStore(fs.root) };
}

const empty = (): ProcessedData => ({ done: [], log: [], flags: {}, pending: {} });

describe("旧ツールの記録を読む", () => {
  it("移植元が書いた記録を読める（Windows の改行・BOM 付きでも）", () => {
    const data = parseProcessedJson(`\ufeff${PYTHON_SAMPLE.replace(/\n/g, "\r\n")}`);
    expect(data.done).toEqual(["TE00009101", "TE00009102"]);
    expect(data.log).toHaveLength(2);
    expect(Object.keys(data.pending)).toEqual(["TE00009103"]);
    expect(data.future_key).toEqual({ note: "移植元にだけある項目も落とさない" });
  });

  it.each([
    ["JSON でない", "これは記録ではない"],
    ["done が無い", '{"log": []}'],
    ["done に数値", '{"done": [1], "log": []}'],
    ["log の行の形が違う", '{"done": [], "log": [{"denpyo_no": "TE1"}]}'],
    ["保留の形が違う", '{"done": [], "log": [], "pending": {"TE1": {"at": "x"}}}'],
  ])("★%sなら読めた分だけ取り込むことはせず、理由を出す", (_label, text) => {
    expect(() => parseProcessedJson(text)).toThrow(ImportError);
  });

  it("別の種類の記録らしい名前なら注意を出す（止めはしない）", () => {
    expect(importNameWarning(tenmatsu, "processed.json")).toBeNull();
    expect(importNameWarning(tenmatsu, "C:\\Users\\x\\tenmatsu-dl\\processed_senketsu.json")).toContain("顛末書の記録（processed.json）ではない");
    expect(importNameWarning(LOCAL_KINDS.senketsu, "processed_senketsu.json")).toBeNull();
    expect(importNameWarning(tenmatsu, "記録の控え.json")).toBeNull();
  });
});

describe("記録を合わせる", () => {
  const incoming = parseProcessedJson(PYTHON_SAMPLE);

  it("★空のフォルダーへ入れると、旧ツールの記録がそのまま入る（保留はファイルがあるときだけ）", () => {
    const { merged, summary } = mergeRecords(empty(), incoming, () => true);
    expect(formatRecords(merged)).toBe(PYTHON_SAMPLE);
    expect(summary).toEqual({
      incoming: 2,
      added: 2,
      already: 0,
      flagsTaken: 1,
      pendingTaken: 1,
      pendingWithoutFiles: [],
      pendingAlreadySaved: [],
    });
  });

  it("★保留のファイルがフォルダーに無ければ、その保留は入れない", () => {
    const { merged, summary } = mergeRecords(empty(), incoming, () => false);
    expect(merged.pending).toEqual({});
    expect(summary.pendingWithoutFiles).toEqual(["TE00009103"]);
  });

  it("★新しい方式で取った記録の後ろではなく前に入る（新しく取った分が一覧の上に来る）", () => {
    const current: ProcessedData = {
      done: ["TE00009201"],
      log: [{ denpyo_no: "TE00009201", file: "顛末書No.9201.pdf", at: "2026-09-13T10:00:00" }],
      flags: {},
      pending: {},
    };
    const { merged, summary } = mergeRecords(current, incoming, () => true);
    expect(merged.done).toEqual(["TE00009101", "TE00009102", "TE00009201"]);
    expect(merged.log.map((e) => e.denpyo_no)).toEqual(["TE00009101", "TE00009102", "TE00009201"]);
    expect(summary.added).toBe(2);
  });

  it("★何度取り込んでも同じ結果になる（重ならない）", () => {
    const once = mergeRecords(empty(), incoming, () => true).merged;
    const twice = mergeRecords(once, incoming, () => true);
    expect(formatRecords(twice.merged)).toBe(formatRecords(once));
    expect(twice.summary).toMatchObject({ added: 0, already: 2, flagsTaken: 0, pendingTaken: 0 });
  });

  it("★完了の印は、伝票ごとに更新日時の新しい方を採る", () => {
    const current: ProcessedData = {
      ...empty(),
      done: ["TE00009101"],
      flags: { TE00009101: { budget_entered: true, cloud_stored: true, updated_at: "2026-09-10T00:00:00" } },
    };
    const newer = mergeRecords(current, incoming, () => true);
    expect(newer.merged.flags.TE00009101).toEqual({ budget_entered: true, cloud_stored: true, updated_at: "2026-09-10T00:00:00" });
    const older = mergeRecords({ ...current, flags: { TE00009101: { cloud_stored: true, updated_at: "2026-09-01T00:00:00" } } }, incoming, () => true);
    expect(older.merged.flags.TE00009101).toEqual(incoming.flags.TE00009101);
  });

  it("★保存済みの伝票の保留は入れない。フォルダーの保留が旧ツールで保存済みなら外す", () => {
    const savedInOld = parseProcessedJson(JSON.stringify({ ...JSON.parse(PYTHON_SAMPLE), done: ["TE00009101", "TE00009102", "TE00009103"] }));
    const { merged, summary } = mergeRecords(empty(), savedInOld, () => true);
    expect(merged.pending).toEqual({});
    expect(summary.pendingAlreadySaved).toEqual(["TE00009103"]);

    const current: ProcessedData = { ...empty(), pending: { TE00009101: { at: "2026-09-13T09:00:00", dir: "TE00009101", missing: [], meta: {} } } };
    const cleaned = mergeRecords(current, incoming, () => true);
    expect(Object.keys(cleaned.merged.pending)).toEqual(["TE00009103"]);
    expect(cleaned.summary.pendingAlreadySaved).toEqual(["TE00009101"]);
  });
});

describe("フォルダーへ取り込む（通し）", () => {
  it("★確認の画面で、取り込むとどうなるか（PDF の見つかり方も）を書かずに示す", async () => {
    const { fs, store } = setup();
    fs.put("顛末書No.9101.pdf", "%PDF-1.4");
    const summary = await previewImport(store, tenmatsu, PYTHON_SAMPLE);
    expect(summary).toMatchObject({ incoming: 2, added: 2, pdfFound: 1, pdfMissing: ["顛末書No.9102.pdf"], pdfMissingCount: 1, pendingWithoutFiles: ["TE00009103"] });
    expect(fs.files()).toEqual(["顛末書No.9101.pdf"]); // 何も書いていない
  });

  it("★取り込むと一覧に出る。記録の控え（.bak）が残り、新しい方式で取った分と印も残る", async () => {
    const { fs, store } = setup();
    await appendProcessed(store, tenmatsu, "TE00009201", "顛末書No.9201.pdf", null, new Date(2026, 8, 13, 10));
    await setFlags(store, tenmatsu, "TE00009201", { cloud_stored: true }, new Date(2026, 8, 13, 11));
    fs.put("_保留/TE00009103/manifest.json", JSON.stringify({ parts: [] }));
    const before = fs.text("_記録/processed.json");

    const summary = await importRecords(store, tenmatsu, PYTHON_SAMPLE);
    expect(summary).toMatchObject({ incoming: 2, added: 2, pendingTaken: 1 });
    expect(fs.text("_記録/processed.json.bak")).toBe(before);

    const records = await readRecords(store, tenmatsu);
    expect(records.done).toEqual(["TE00009101", "TE00009102", "TE00009201"]);
    expect(records.flags.TE00009201.cloud_stored).toBe(true);
    expect(records.future_key).toBeDefined();

    const items = await buildListItems(store, tenmatsu, memoryStatsCache());
    expect(items.map((i) => [i.denpyo_no, i.pending])).toEqual([
      ["TE00009103", true],
      ["TE00009201", false],
      ["TE00009102", false],
      ["TE00009101", false],
    ]);
    expect(items.find((i) => i.denpyo_no === "TE00009101")).toMatchObject({ budget_entered: true, cloud_stored: false, amount: "16,500 円" });
  });

  it("壊れた記録は取り込まず、フォルダーの記録も変えない", async () => {
    const { fs, store } = setup();
    await registerPending(store, tenmatsu, "TE1", "TE1", [], null);
    const before = fs.text("_記録/processed.json");
    await expect(importRecords(store, tenmatsu, "{壊れている")).rejects.toBeInstanceOf(ImportError);
    expect(fs.text("_記録/processed.json")).toBe(before);
  });
});
