import { describe, expect, it } from "vitest";
import { SHARED_DATASETS } from "@/lib/shared/datasets";
import {
  type SharedCustomerEdits,
  mergeCustomerEdits,
  pickSharedCustomerEdits,
} from "@/lib/shared/customer-edits";
import { SharedCorruptError, SharedVersionError, formatEnvelope } from "@/lib/shared/envelope";
import {
  type SharedExamples,
  mergeSharedExamples,
  pickSharedExamples,
} from "@/lib/shared/examples";
import {
  DEFAULT_SHARED_TIMING,
  SharedBusyError,
  SharedFolder,
  sharedErrorText,
  statChanged,
} from "@/lib/shared/folder";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import { FakeFs } from "./helpers/fake-fs";

// 共有フォルダーの読み書き（2026-09-22）。
// ★**同じフォルダーに FolderStore を2つ作って「別のPC」**を再現する。
//   利用者は2人。書き負けても次の同期で戻ることを、ここで確かめる。

const EDITS = SHARED_DATASETS["customer-edits"];
const LEARN = SHARED_DATASETS["examples-inquiry"];

/** 待たないで試す（読み直しの回数だけ見る） */
const QUICK = { ...DEFAULT_SHARED_TIMING, readWaitMs: 0, sleep: async () => {} };

const setup = () => {
  const fs = new FakeFs("Folio共有");
  // ★同じフォルダーを別々の端末が開いている状態
  const a = new SharedFolder(new FolderStore(fs.root), "device-A", QUICK);
  const b = new SharedFolder(new FolderStore(fs.root), "device-B", QUICK);
  return { fs, a, b };
};

const entry = (over: Partial<SharedCustomerEdits[string]> = {}): SharedCustomerEdits[string] => ({
  source: "dx",
  sourceKey: "2101230101",
  edits: {},
  editStamps: {},
  editedAt: 0,
  ...over,
});

/** その端末の手直しを共有フォルダーへ重ねる（実際の同期と同じ形） */
const push = (folder: SharedFolder, mine: SharedCustomerEdits, now: number) =>
  folder.update(EDITS, pickSharedCustomerEdits, (current) =>
    current ? mergeCustomerEdits(current, mine) : mine, now);

describe("書く・読む・控え", () => {
  it("初めて書くときは控えを作らない", async () => {
    const { fs, a } = setup();
    const result = await push(a, { "dx:2101230101": entry({ edits: { memo: "A" }, editStamps: { memo: 10 }, editedAt: 10 }) }, 1);
    expect(result.written).toBe(true);
    expect(fs.files()).toEqual(["顧客の手直し.json"]);
  });

  it("2回目からは控えを1世代だけ残す", async () => {
    const { fs, a } = setup();
    await push(a, { "dx:1": entry({ edits: { memo: "1回目" }, editStamps: { memo: 10 }, editedAt: 10 }) }, 1);
    await push(a, { "dx:2": entry({ edits: { memo: "2回目" }, editStamps: { memo: 20 }, editedAt: 20 }) }, 2);
    expect(fs.files().sort()).toEqual(["顧客の手直し.json", "顧客の手直し.json.bak"]);
    // 控えは1つ前の中身
    expect(fs.text("顧客の手直し.json.bak")).toContain("1回目");
    expect(fs.text("顧客の手直し.json.bak")).not.toContain("2回目");
  });

  it("★中身が変わっていなければ書かない（控えを無駄に潰さない）", async () => {
    const { fs, a } = setup();
    const mine = { "dx:1": entry({ edits: { memo: "同じ" }, editStamps: { memo: 10 }, editedAt: 10 }) };
    await push(a, mine, 1);
    const before = fs.text("顧客の手直し.json");
    const again = await push(a, mine, 2);
    expect(again.written).toBe(false);
    // 書いた時刻（updatedAt）も変わらない＝ファイルに触っていない
    expect(fs.text("顧客の手直し.json")).toBe(before);
    expect(fs.files()).toEqual(["顧客の手直し.json"]);
  });

  it("まだ誰も書いていなければ、読んでも null", async () => {
    const { a } = setup();
    expect((await a.read(EDITS, pickSharedCustomerEdits)).envelope).toBeNull();
    expect(await a.hasDataset(EDITS)).toBe(false);
  });
});

describe("★別のPCとのやりとり", () => {
  it("Aが書いたものをBが読める", async () => {
    const { a, b } = setup();
    await push(a, { "dx:1": entry({ edits: { memo: "Aの手直し" }, editStamps: { memo: 10 }, editedAt: 10 }) }, 1);
    const read = await b.read(EDITS, pickSharedCustomerEdits);
    expect(read.envelope?.items["dx:1"].edits).toEqual({ memo: "Aの手直し" });
    expect(read.envelope?.writer).toBe("device-A");
  });

  it("★別々の項目を直したら、両方が残る（片方が黙って消えない）", async () => {
    const { a, b } = setup();
    await push(a, { "dx:1": entry({ edits: { memo: "Aのメモ" }, editStamps: { memo: 10 }, editedAt: 10 }) }, 1);
    await push(b, { "dx:1": entry({ edits: { supervisor: "架空　花子" }, editStamps: { supervisor: 20 }, editedAt: 20 }) }, 2);
    const merged = (await a.read(EDITS, pickSharedCustomerEdits)).envelope?.items["dx:1"];
    expect(merged?.edits).toEqual({ memo: "Aのメモ", supervisor: "架空　花子" });
  });

  it("同じ項目なら、あとから直した方が残る", async () => {
    const { a, b } = setup();
    await push(a, { "dx:1": entry({ edits: { memo: "古い" }, editStamps: { memo: 10 }, editedAt: 10 }) }, 1);
    await push(b, { "dx:1": entry({ edits: { memo: "新しい" }, editStamps: { memo: 20 }, editedAt: 20 }) }, 2);
    expect((await a.read(EDITS, pickSharedCustomerEdits)).envelope?.items["dx:1"].edits).toEqual({
      memo: "新しい",
    });
  });

  it("学習した書き方も同じように行き来し、消した印が伝わる", async () => {
    const { a, b } = setup();
    const ex = (id: string, output: string, updatedAt: number) => ({
      id,
      input: "浴室の換気扇から異音がする",
      output,
      createdAt: 1,
      updatedAt,
    });
    const put = (folder: SharedFolder, mine: SharedExamples, now: number) =>
      folder.update(LEARN, pickSharedExamples, (current) =>
        current ? mergeSharedExamples(current, mine) : mine, now);

    await put(a, { items: [ex("c-1", "Aが覚えた", 10)], deleted: {} }, 1);
    await put(b, { items: [ex("c-2", "Bが覚えた", 20)], deleted: {} }, 2);
    const both = (await a.read(LEARN, pickSharedExamples)).envelope?.items;
    expect(both?.items.map((i) => i.id).sort()).toEqual(["c-1", "c-2"]);

    // B が c-1 を消す → A から見ても消えている
    await put(b, { items: [], deleted: { "c-1": 30 } }, 3);
    const after = (await a.read(LEARN, pickSharedExamples)).envelope?.items;
    expect(after?.items.map((i) => i.id)).toEqual(["c-2"]);
  });
});

describe("★同時に書いたとき（読んでから書くまでに割り込まれる）", () => {
  it("読んだあとに相手が書いていたら、読み直して相手の分を残す", async () => {
    const { fs, a } = setup();
    await push(a, { "dx:1": entry({ edits: { memo: "はじめ" }, editStamps: { memo: 10 }, editedAt: 10 }) }, 1);

    // A が読んでから書くまでの隙に、B が書いた状態を作る
    let interrupted = false;
    const result = await a.update(
      EDITS,
      pickSharedCustomerEdits,
      (current) => {
        if (!interrupted) {
          interrupted = true;
          const fromB: SharedCustomerEdits = {
            "dx:1": entry({ edits: { memo: "はじめ", salesRep: "Bが入れた" }, editStamps: { memo: 10, salesRep: 50 }, editedAt: 50 }),
          };
          fs.put("顧客の手直し.json", formatEnvelope(EDITS, fromB, "device-B", 99));
        }
        return mergeCustomerEdits(current ?? {}, {
          "dx:1": entry({ edits: { memo: "Aが直した" }, editStamps: { memo: 60 }, editedAt: 60 }),
        });
      },
      2,
    );

    // ★やり直したうえで、A の分も B の分も残っている
    expect(result.retries).toBeGreaterThan(0);
    expect(result.items["dx:1"].edits).toEqual({ memo: "Aが直した", salesRep: "Bが入れた" });
  });

  it("何度やり直しても落ち着かなければ、書かずに知らせる", async () => {
    const { fs, a } = setup();
    await push(a, { "dx:1": entry({ edits: { memo: "はじめ" }, editStamps: { memo: 10 }, editedAt: 10 }) }, 1);
    let n = 0;
    const attempt = a.update(
      EDITS,
      pickSharedCustomerEdits,
      (current) => {
        // 毎回、読んだ直後に誰かが書き換える（長さを変えて、確かに変わったと分かるようにする）
        n += 1;
        const fromB = { [`dx:${n}`]: entry({ edits: { memo: "B".repeat(n) }, editStamps: { memo: n }, editedAt: n }) };
        fs.put("顧客の手直し.json", formatEnvelope(EDITS, fromB, "device-B", n));
        return mergeCustomerEdits(current ?? {}, { "dx:A": entry({ edits: { memo: "A" }, editStamps: { memo: 99 }, editedAt: 99 }) });
      },
      2,
    );
    await expect(attempt).rejects.toBeInstanceOf(SharedBusyError);
    // ★書いていない（相手の書き込みを潰していない）
    expect(fs.text("顧客の手直し.json")).toContain("device-B");
  });

  it("変化の見分けは、大きさと更新時刻の両方で見る（Box は大きさが変わらないことがある）", () => {
    const base = { exists: true, size: 247, lastModified: 1000 };
    expect(statChanged(base, base)).toBe(false);
    expect(statChanged(base, { ...base, lastModified: 2000 })).toBe(true);
    expect(statChanged(base, { ...base, size: 248 })).toBe(true);
    expect(statChanged(base, { exists: false, size: -1, lastModified: -1 })).toBe(true);
  });
});

describe("読めないファイルは止める（自分で直さない）", () => {
  it("壊れたファイルは書き換えずに止める（控えは無傷）", async () => {
    const { fs, a } = setup();
    await push(a, { "dx:1": entry({ edits: { memo: "無事な控え" }, editStamps: { memo: 10 }, editedAt: 10 }) }, 1);
    await push(a, { "dx:2": entry({ edits: { memo: "2回目" }, editStamps: { memo: 20 }, editedAt: 20 }) }, 2);
    fs.put("顧客の手直し.json", "{壊れている");

    await expect(push(a, { "dx:3": entry() }, 3)).rejects.toBeInstanceOf(SharedCorruptError);
    // ★壊れたまま置いておく（勝手に直さない）。控えは残っている
    expect(fs.text("顧客の手直し.json")).toBe("{壊れている");
    expect(fs.text("顧客の手直し.json.bak")).toContain("無事な控え");
  });

  it("★半端なファイル（同期の途中）は読み直す", async () => {
    const { fs, a } = setup();
    const good = formatEnvelope(EDITS, { "dx:1": entry({ edits: { memo: "揃った" }, editStamps: { memo: 10 }, editedAt: 10 }) }, "device-B", 1);
    fs.put("顧客の手直し.json", good.slice(0, 20)); // 途中まで
    let reads = 0;
    const folder = new SharedFolder(a.store, "device-A", {
      ...QUICK,
      sleep: async () => {
        // 2回目の読みでは揃っている（同期が追いついた）
        reads += 1;
        if (reads === 1) fs.put("顧客の手直し.json", good);
      },
    });
    const read = await folder.read(EDITS, pickSharedCustomerEdits);
    expect(read.envelope?.items["dx:1"].edits).toEqual({ memo: "揃った" });
  });

  it("★新しい版のファイルは書き換えない（新しい Folio の書いた形を壊さない）", async () => {
    const { fs, a } = setup();
    const future = JSON.parse(formatEnvelope(EDITS, {}, "device-B", 1));
    future.schemaVersion = 99;
    fs.put("顧客の手直し.json", JSON.stringify(future));
    await expect(push(a, { "dx:1": entry() }, 2)).rejects.toBeInstanceOf(SharedVersionError);
    expect(JSON.parse(fs.text("顧客の手直し.json")!).schemaVersion).toBe(99);
  });

  it("形の違う1件は落として、ほかの手直しは読む", async () => {
    const { fs, a } = setup();
    const mixed = { "dx:1": entry({ edits: { memo: "生きている" }, editStamps: { memo: 10 }, editedAt: 10 }), "dx:bad": { edits: 1 } };
    fs.put("顧客の手直し.json", formatEnvelope(EDITS, mixed, "device-B", 1));
    const read = await a.read(EDITS, pickSharedCustomerEdits);
    expect(Object.keys(read.envelope?.items ?? {})).toEqual(["dx:1"]);
  });
});

describe("困ったときの文面", () => {
  it("フォルダーが無くなったら、つなぎ直すよう伝える", async () => {
    const { fs, a } = setup();
    fs.vanish();
    const error = await a.probe().catch((e: unknown) => e);
    expect(sharedErrorText(error)).toContain("共有フォルダーが見つかりません");
    expect(sharedErrorText(error)).toContain("Box");
  });

  it("許可が無いときは、つなぐボタンへ案内する", async () => {
    const { fs, a } = setup();
    fs.deny();
    const error = await a.probe().catch((e: unknown) => e);
    expect(sharedErrorText(error)).toContain("許可");
  });

  it("★掴まれているときは、PDF向けではなく共有フォルダー向けの言い方にする", async () => {
    const { fs, a } = setup();
    fs.lock("顧客の手直し.json");
    const error = await push(a, { "dx:1": entry({ edits: { memo: "A" }, editStamps: { memo: 1 }, editedAt: 1 }) }, 1).catch((e: unknown) => e);
    const text = sharedErrorText(error);
    expect(text).toContain("Box の同期中");
    expect(text).not.toContain("PDF");
  });
});
