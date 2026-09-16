import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KINDS } from "@/lib/rakuraku/kinds";
import { DOC_KIND_BY_ID } from "@/lib/tenmatsu/kinds";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import { LOCAL_KINDS } from "@/lib/tenmatsu/local/kind-config";
import {
  RecordNotFoundError,
  RecordsCorruptError,
  appendProcessed,
  doneAndPending,
  formatRecords,
  hasValue,
  localStamp,
  readRecords,
  registerPending,
  retryPending,
  setFlags,
  writeRecords,
} from "@/lib/tenmatsu/local/records";
import { FakeFs } from "./helpers/fake-fs";

const PYTHON_SAMPLE = readFileSync(new URL("./tenmatsu-local/processed_python.json", import.meta.url), "utf-8");
const tenmatsu = LOCAL_KINDS.tenmatsu;
const NOW = new Date(2026, 8, 13, 9, 5, 7);

const setup = () => {
  const fs = new FakeFs();
  return { fs, store: new FolderStore(fs.root) };
};

describe("書類の種類ごとの記録の設定", () => {
  it("記録のファイル名は移植元と同じ", () => {
    expect(LOCAL_KINDS.tenmatsu.processedFile).toBe("processed.json");
    expect(LOCAL_KINDS.senketsu.processedFile).toBe("processed_senketsu.json");
    expect(LOCAL_KINDS.natsuin.processedFile).toBe("processed_natsuin.json");
  });

  it("★記録に残す項目は移植元と同じ順（顛末書）", () => {
    expect(tenmatsu.metaKeys).toEqual([
      "shinsei_date",
      "shinseisha",
      "amount",
      "payee",
      "where",
      "pj",
      "final_approved_at",
      "skipped_attachments",
      "missing_attachments",
      "replaced_attachments",
      "final_name",
      "linked_attachments",
      "recomposed_at",
    ]);
  });

  it("★捺印決裁書は、紐づく専決決裁書から写す支払先・金額も記録に残す（落とされない）", () => {
    expect(LOCAL_KINDS.natsuin.metaKeys).toEqual(expect.arrayContaining(["payee", "amount", "senketsu_no", "remarks", "content"]));
  });

  it("★完了の印は画面の設定と同じ（取り違えると押した印が保存されない）", () => {
    for (const id of ["tenmatsu", "senketsu", "natsuin"] as const) {
      expect(LOCAL_KINDS[id].flagKeys).toEqual(DOC_KIND_BY_ID[id].flagKeys);
      expect(LOCAL_KINDS[id].filePrefix).toBe(KINDS[id].filePrefix);
    }
  });
});

describe("記録を読む・書く", () => {
  it("無ければ空の形", async () => {
    const { store } = setup();
    expect(await readRecords(store, tenmatsu)).toEqual({ done: [], log: [], flags: {}, pending: {} });
  });

  it("★移植元（Python）が書いた記録を読んで書き戻すと、同じ文字列になる（知らない項目も残る）", async () => {
    const { fs, store } = setup();
    fs.put("_記録/processed.json", PYTHON_SAMPLE);
    const data = await readRecords(store, tenmatsu);
    expect(data.done).toHaveLength(2);
    await writeRecords(store, tenmatsu, data);
    expect(fs.text("_記録/processed.json")).toBe(PYTHON_SAMPLE);
    expect(formatRecords(data)).toBe(PYTHON_SAMPLE);
  });

  it("★Windows で書かれた記録（CRLF・BOM付き）も読める", async () => {
    const { fs, store } = setup();
    fs.put("_記録/processed.json", `\ufeff${PYTHON_SAMPLE.replace(/\n/g, "\r\n")}`);
    // ★移植元（Python）が書いた記録は「顛末書No.」のまま読める（表記を変えても壊さない）
    expect((await readRecords(store, tenmatsu)).log[0].file).toBe("顛末書No.9101.pdf");
  });

  it("★書くたびに1つ前の内容を .bak に残す（1世代だけ）", async () => {
    const { fs, store } = setup();
    fs.put("_記録/processed.json", PYTHON_SAMPLE);
    await appendProcessed(store, tenmatsu, "TE00009104", "顛末書№9104.pdf", null, NOW);
    expect(fs.text("_記録/processed.json.bak")).toBe(PYTHON_SAMPLE);
    const afterFirst = fs.text("_記録/processed.json");
    await appendProcessed(store, tenmatsu, "TE00009105", "顛末書№9105.pdf", null, NOW);
    expect(fs.text("_記録/processed.json.bak")).toBe(afterFirst);
  });

  it("★壊れていたら自動で直さず、控えの場所を伝えて止める", async () => {
    const { fs, store } = setup();
    fs.put("_記録/processed.json", '{"done": [');
    fs.put("_記録/processed.json.bak", PYTHON_SAMPLE);
    const error = await readRecords(store, tenmatsu).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecordsCorruptError);
    expect((error as RecordsCorruptError).backupExists).toBe(true);
    expect((error as Error).message).toContain("_記録/processed.json.bak");
    // 書き換えも止まる（壊れた記録を上書きして消さない）
    await expect(appendProcessed(store, tenmatsu, "TE1", "a.pdf", null)).rejects.toBeInstanceOf(RecordsCorruptError);
    expect(fs.text("_記録/processed.json")).toBe('{"done": [');
  });

  it("★書いている途中で失敗しても、元の記録は壊れない", async () => {
    const { fs, store } = setup();
    fs.put("_記録/processed.json", PYTHON_SAMPLE);
    fs.failClose("_記録/processed.json");
    await expect(appendProcessed(store, tenmatsu, "TE1", "a.pdf", null)).rejects.toThrow();
    expect(fs.text("_記録/processed.json")).toBe(PYTHON_SAMPLE);
  });

  it("★初めて書く途中で失敗しても、空の記録ファイルを残さない", async () => {
    const { fs, store } = setup();
    fs.failClose("_記録/processed.json");
    await expect(appendProcessed(store, tenmatsu, "TE1", "a.pdf", null)).rejects.toThrow();
    expect(fs.files()).toEqual([]);
  });

  it("空の記録ファイルだけが残っていたら（控えも無ければ）まだ記録が無いとみなす", async () => {
    const { fs, store } = setup();
    fs.put("_記録/processed.json", "");
    expect((await readRecords(store, tenmatsu)).done).toEqual([]);
    fs.put("_記録/processed.json.bak", PYTHON_SAMPLE);
    await expect(readRecords(store, tenmatsu)).rejects.toBeInstanceOf(RecordsCorruptError);
  });

  it("日時は移植元と同じ形（この PC の時刻・秒まで・時差なし）", () => {
    expect(localStamp(NOW)).toBe("2026-09-13T09:05:07");
  });
});

describe("保存できた伝票を記録する", () => {
  it("★記録に残す項目だけを決まった順で、値があるものだけ入れる（知らない項目・空の値は入れない）", async () => {
    const { fs, store } = setup();
    await appendProcessed(
      store,
      tenmatsu,
      "TE00009104",
      "顛末書№9104.pdf",
      {
        where: "注文受注物件：架空邸",
        shinsei_date: "2026/09/10 11:37:00",
        payee: "",
        amount: null,
        skipped_attachments: [],
        secret: "記録に残さない",
        final_approved_at: "2026/09/10 17:36",
      },
      NOW,
    );
    const data = JSON.parse(fs.text("_記録/processed.json")!);
    expect(Object.keys(data.log[0])).toEqual(["denpyo_no", "file", "at", "shinsei_date", "where", "final_approved_at"]);
    expect(data.log[0].at).toBe("2026-09-13T09:05:07");
    expect(data.done).toEqual(["TE00009104"]);
  });

  it("同じ伝票をもう一度記録しても done は増やさない（log は残す）", async () => {
    const { store } = setup();
    await appendProcessed(store, tenmatsu, "TE1", "a.pdf", null, NOW);
    await appendProcessed(store, tenmatsu, "TE1", "a_2.pdf", null, NOW);
    const data = await readRecords(store, tenmatsu);
    expect(data.done).toEqual(["TE1"]);
    expect(data.log.map((e) => e.file)).toEqual(["a.pdf", "a_2.pdf"]);
  });

  it("★同時に記録しても、どちらも失われない（読む→書くの間に割り込ませない）", async () => {
    const { store } = setup();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => appendProcessed(store, tenmatsu, `TE${i}`, `${i}.pdf`, null, NOW)),
    );
    expect((await readRecords(store, tenmatsu)).done).toHaveLength(10);
  });

  it("1つが失敗しても、後に続く書き換えは止まらない", async () => {
    const { fs, store } = setup();
    fs.failClose("_記録/processed.json");
    const first = appendProcessed(store, tenmatsu, "TE1", "a.pdf", null, NOW);
    const second = appendProcessed(store, tenmatsu, "TE2", "b.pdf", null, NOW);
    await expect(first).rejects.toThrow();
    await second;
    expect((await readRecords(store, tenmatsu)).done).toEqual(["TE2"]);
  });

  it("種類ごとに別のファイルに書く", async () => {
    const { fs, store } = setup();
    await appendProcessed(store, LOCAL_KINDS.senketsu, "SE1", "専決決裁書№0001.pdf", null, NOW);
    expect(fs.files()).toEqual(["_記録/processed_senketsu.json"]);
  });
});

describe("完了の印", () => {
  it("指定した印だけを変え、null は触らない。すでにある項目の位置は変えない", async () => {
    const { fs, store } = setup();
    fs.put("_記録/processed.json", PYTHON_SAMPLE);
    const flags = await setFlags(store, tenmatsu, "TE00009101", { cloud_stored: true, budget_entered: null }, NOW);
    expect(flags).toEqual({ budget_entered: true, updated_at: "2026-09-13T09:05:07", cloud_stored: true });
    expect(Object.keys(flags)).toEqual(["budget_entered", "updated_at", "cloud_stored"]);
  });

  it("★保存済みの伝票にしか付けられない", async () => {
    const { fs, store } = setup();
    fs.put("_記録/processed.json", PYTHON_SAMPLE);
    await expect(setFlags(store, tenmatsu, "TE00009103", { cloud_stored: true })).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("★その種類に無い印は断る（専決決裁書に実行予算は無い）", async () => {
    const { store } = setup();
    await expect(setFlags(store, LOCAL_KINDS.senketsu, "SE1", { budget_entered: true })).rejects.toThrow("知らない印です");
  });

  it("true / false 以外は断る", async () => {
    const { store } = setup();
    await expect(setFlags(store, tenmatsu, "TE1", { cloud_stored: "yes" as unknown as boolean })).rejects.toThrow("true / false");
  });
});

describe("保留", () => {
  it("保留として記録する（記録に残す項目で値のあるものだけ）", async () => {
    const { store } = setup();
    await registerPending(
      store,
      tenmatsu,
      "TE00009106",
      "TE00009106",
      [{ index: 2, name: "見積.xlsx", reason: "結合できない形式です" }],
      { amount: "3,300 円", secret: "残さない", payee: "" },
      NOW,
    );
    const data = await readRecords(store, tenmatsu);
    expect(data.pending.TE00009106).toEqual({
      at: "2026-09-13T09:05:07",
      dir: "TE00009106",
      missing: [{ index: 2, name: "見積.xlsx", reason: "結合できない形式です" }],
      meta: { amount: "3,300 円" },
    });
    // ★保留中の伝票も取得の対象から外す
    expect(doneAndPending(data)).toEqual(["TE00009106"]);
  });

  it("★保留をやめると、記録を消してからフォルダーも消す（捺印決裁書は部品も）", async () => {
    const { fs, store } = setup();
    const natsuin = LOCAL_KINDS.natsuin;
    await registerPending(store, natsuin, "NA1", "NA1", [], null, NOW);
    fs.put("_保留/NA1/000_本体.pdf", "1");
    fs.put("_部品/NA1/manifest.json", "{}");
    fs.put("_保留/NA2/000_本体.pdf", "1");
    await retryPending(store, natsuin, "NA1");
    expect((await readRecords(store, natsuin)).pending).toEqual({});
    expect(fs.files()).toEqual(["_保留/NA2/000_本体.pdf", "_記録/processed_natsuin.json", "_記録/processed_natsuin.json.bak"]);
  });

  it("記録に無い保留はやめられない", async () => {
    const { store } = setup();
    await expect(retryPending(store, tenmatsu, "TE404")).rejects.toBeInstanceOf(RecordNotFoundError);
  });
});

describe("値があるか（Python の真偽と同じ）", () => {
  it.each([
    [null, false],
    [undefined, false],
    ["", false],
    [0, false],
    [false, false],
    [[], false],
    [{}, false],
    ["0", true],
    [["a"], true],
    [{ a: 1 }, true],
    [true, true],
    [1, true],
  ])("%j → %s", (value, expected) => {
    expect(hasValue(value)).toBe(expected);
  });
});
