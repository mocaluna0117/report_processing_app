import { describe, expect, it } from "vitest";
import {
  type FolderFile,
  type SeenCustomerFiles,
  decideLedgerImport,
  conflictingSources,
  fileChanged,
  isSeenCustomerFiles,
  ledgerConflictText,
  ledgerPutText,
  keepMarks,
  ledgerImportedText,
  markOf,
  pickCustomerFiles,
  staleWrittenFiles,
} from "@/lib/shared/customer-files";

// 共有フォルダーに置いた顧客データのファイルを、2人目も自動で取り込めるようにする（2026-09-23）。
// ★これまでは「2人が同じ xlsx を手で取り込む」前提だった。助っ人クラウドの id は行の内容の
//   ハッシュなので、別のファイルだと手直しが結び付かない。共有フォルダーから読めば必ず揃う。
// ★手で取り込む道（ドラッグ＆ドロップ）は残す。顧客は今後も増えるため。

const file = (name: string, size = 1_000, lastModified = 1_700_000_000_000): FolderFile => ({
  name,
  size,
  lastModified,
});

describe("顧客データらしいファイルを選ぶ", () => {
  it("xlsx・xls・csv を拾い、名前順に並べる", () => {
    const picked = pickCustomerFiles([
      file("点検保守台帳.xlsx"),
      file("顧客の手直し.json"),
      file("助っ人クラウド.csv"),
      file("古い台帳.xls"),
    ]);
    expect(picked.map((f) => f.name)).toEqual(["助っ人クラウド.csv", "古い台帳.xls", "点検保守台帳.xlsx"]);
  });

  it("★共有フォルダーの JSON と控えは拾わない", () => {
    const picked = pickCustomerFiles([
      file("顧客の手直し.json"),
      file("顧客の手直し.json.bak"),
      file("学習した書き方_アフター.json"),
    ]);
    expect(picked).toEqual([]);
  });

  it("★Excel が開いている間の一時ファイルは拾わない", () => {
    expect(pickCustomerFiles([file("~$点検保守台帳.xlsx")])).toEqual([]);
  });

  it("中身が空のファイルは拾わない（同期の途中）", () => {
    expect(pickCustomerFiles([file("点検保守台帳.xlsx", 0)])).toEqual([]);
  });

  it("大文字の拡張子でも拾う", () => {
    expect(pickCustomerFiles([file("台帳.XLSX")]).length).toBe(1);
  });
});

describe("前に取り込んだときから変わったか", () => {
  const seen: SeenCustomerFiles = { "台帳.xlsx": { size: 1_000, lastModified: 100 } };

  it("初めて見るファイルは「変わった」", () => {
    expect(fileChanged({}, file("台帳.xlsx"))).toBe(true);
  });

  it("大きさも更新時刻も同じなら、取り込み直さない", () => {
    expect(fileChanged(seen, file("台帳.xlsx", 1_000, 100))).toBe(false);
  });

  it("★大きさが同じでも更新時刻が違えば取り込み直す（Box は大きさが変わらないことがある）", () => {
    expect(fileChanged(seen, file("台帳.xlsx", 1_000, 200))).toBe(true);
  });

  it("大きさが違えば取り込み直す", () => {
    expect(fileChanged(seen, file("台帳.xlsx", 2_000, 100))).toBe(true);
  });

  it("印はファイルの大きさと更新時刻だけを持つ", () => {
    expect(markOf(file("台帳.xlsx", 5, 7))).toEqual({ size: 5, lastModified: 7 });
  });

  it("取り込み元と、自分で置いたかも覚えられる", () => {
    expect(markOf(file("台帳.xlsx", 5, 7), "dx", true)).toEqual({
      size: 5,
      lastModified: 7,
      source: "dx",
      mine: true,
    });
  });
});

describe("フォルダーから消えたファイルの印", () => {
  it("★印は落とすが、顧客は消さない（ファイルを片付けただけで台帳が消えたら困る）", () => {
    const seen: SeenCustomerFiles = {
      "台帳.xlsx": { size: 1, lastModified: 1 },
      "去年の台帳.xlsx": { size: 2, lastModified: 2 },
    };
    expect(keepMarks(seen, [file("台帳.xlsx")])).toEqual({ "台帳.xlsx": { size: 1, lastModified: 1 } });
  });

  it("形の合わない控えは読み捨てる", () => {
    expect(isSeenCustomerFiles({ "a.xlsx": { size: 1, lastModified: 2 } })).toBe(true);
    expect(isSeenCustomerFiles({ "a.xlsx": { size: "1" } })).toBe(false);
    expect(isSeenCustomerFiles(null)).toBe(false);
    expect(isSeenCustomerFiles([1])).toBe(false);
  });
});

describe("取り込んでよいかの判定", () => {
  const base = { fileName: "台帳.xlsx", existing: 100, incoming: 100, confirmed: false };

  it("点検保守台帳は足し込むだけなので、いつでも取り込む", () => {
    expect(decideLedgerImport({ ...base, source: "dx", incoming: 1 }).kind).toBe("import");
  });

  it("助っ人クラウドでも、増える・同じなら取り込む", () => {
    expect(decideLedgerImport({ ...base, source: "suketto", incoming: 100 }).kind).toBe("import");
    expect(decideLedgerImport({ ...base, source: "suketto", incoming: 120 }).kind).toBe("import");
  });

  it("この端末にまだ無ければ、失うものが無いので取り込む", () => {
    expect(decideLedgerImport({ ...base, source: "suketto", existing: 0, incoming: 1 }).kind).toBe("import");
  });

  it("★減るときは黙って入れ替えず、件数を出して確かめる", () => {
    const decision = decideLedgerImport({ ...base, source: "suketto", existing: 3_000, incoming: 12 });
    expect(decision.kind).toBe("ask");
    if (decision.kind !== "ask") throw new Error("ask のはず");
    expect(decision.text).toContain("台帳.xlsx");
    expect(decision.text).toContain("3,000件");
    expect(decision.text).toContain("12件");
    expect(decision.text).toContain("助っ人クラウド");
  });

  it("確かめてもらえたら取り込む", () => {
    expect(
      decideLedgerImport({ ...base, source: "suketto", existing: 3_000, incoming: 12, confirmed: true }).kind,
    ).toBe("import");
  });
});

describe("取り込めたときの1行", () => {
  it("何件どうなったかを出す", () => {
    const text = ledgerImportedText({ fileName: "台帳.xlsx", source: "dx", added: 5, updated: 2, removed: 0 });
    expect(text).toContain("台帳.xlsx");
    expect(text).toContain("点検保守台帳");
    expect(text).toContain("追加 5件");
    expect(text).toContain("更新 2件");
    expect(text).not.toContain("削除");
  });

  it("消えた件数は、あるときだけ出す", () => {
    const text = ledgerImportedText({ fileName: "台帳.xlsx", source: "suketto", added: 0, updated: 0, removed: 3 });
    expect(text).toContain("削除 3件");
  });
});

describe("同じ取り込み元のファイルが2つ以上あるとき", () => {
  it("★助っ人クラウドが2つあれば、どれを使うか決められないとみなす", () => {
    const found = conflictingSources([
      { name: "助っ人_9月.csv", source: "suketto" },
      { name: "助っ人_10月.csv", source: "suketto" },
      { name: "台帳.csv", source: "dx" },
    ]);
    expect(found).toEqual([{ source: "suketto", files: ["助っ人_10月.csv", "助っ人_9月.csv"] }]);
  });

  it("★点検保守台帳は何個あってもよい（物件番号で足し込むだけ）", () => {
    const found = conflictingSources([
      { name: "台帳_9月.csv", source: "dx" },
      { name: "台帳_10月.csv", source: "dx" },
    ]);
    expect(found).toEqual([]);
  });

  it("1つなら何も言わない", () => {
    expect(conflictingSources([{ name: "助っ人.csv", source: "suketto" }])).toEqual([]);
  });

  it("どう直せばよいかまで書く", () => {
    const text = ledgerConflictText("suketto", ["助っ人_9月.csv", "助っ人_10月.csv"]);
    expect(text).toContain("助っ人クラウド");
    expect(text).toContain("助っ人_9月.csv");
    expect(text).toContain("1つだけを残して");
    expect(text).toContain("取り込みは止めています");
  });
});

describe("自分で置いた古いファイルの片付け", () => {
  const seen = {
    "助っ人_9月.csv": { size: 1, lastModified: 1, source: "suketto" as const, mine: true },
    "助っ人_10月.csv": { size: 2, lastModified: 2, source: "suketto" as const, mine: true },
    "台帳.csv": { size: 3, lastModified: 3, source: "dx" as const, mine: true },
    "誰かが置いた助っ人.csv": { size: 4, lastModified: 4, source: "suketto" as const },
  };

  it("同じ取り込み元で、いま置いたもの以外を挙げる", () => {
    expect(staleWrittenFiles(seen, "suketto", "助っ人_10月.csv")).toEqual(["助っ人_9月.csv"]);
  });

  it("★利用者が手で置いたファイルには触らない", () => {
    expect(staleWrittenFiles(seen, "suketto", "新しい助っ人.csv")).not.toContain("誰かが置いた助っ人.csv");
  });

  it("取り込み元が違うものは片付けない", () => {
    expect(staleWrittenFiles(seen, "dx", "新しい台帳.csv")).toEqual(["台帳.csv"]);
  });

  it("置けたときは、片付けた分も書く", () => {
    expect(ledgerPutText("助っ人_10月.csv", ["助っ人_9月.csv"])).toContain("古い助っ人_9月.csvは外しました");
    expect(ledgerPutText("台帳.csv", [])).not.toContain("外しました");
    expect(ledgerPutText("台帳.csv", [])).toContain("もう1台でも同じ台帳になります");
  });
});
