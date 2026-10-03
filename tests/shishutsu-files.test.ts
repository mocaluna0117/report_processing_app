import { describe, expect, it } from "vitest";
import { guessFile, listFolderXlsx } from "@/lib/shishutsu/files";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import { FakeFs } from "./helpers/fake-fs";

// 共有フォルダーの中から進捗管理表を探す。名前は見本の付け方を真似た架空のもの

describe("共有フォルダーの中の xlsx", () => {
  it("★サブフォルダーも探し、Folio のデータ置き場・一時ファイル・xlsx 以外は候補にしない", async () => {
    const fs = new FakeFs("共有");
    fs.put("2026.4～アフター進捗管理表（8期）.xlsx", "x");
    fs.put("進捗/2026.4～アフター進捗管理表（現場対応なし）.xlsx", "x");
    fs.put("進捗/~$2026.4～アフター進捗管理表（8期）.xlsx", "x");
    fs.put("_data/顧客データ.xlsx", "x");
    fs.put("メモ.txt", "x");
    fs.put("a/b/c/d/深すぎる.xlsx", "x");
    const files = await listFolderXlsx(new FolderStore(fs.root));
    expect(files.map((f) => f.path.join("/"))).toEqual([
      "2026.4～アフター進捗管理表（8期）.xlsx",
      "進捗/2026.4～アフター進捗管理表（現場対応なし）.xlsx",
    ]);
  });

  it("★名前で表の種類の見当を付ける（アフターと現場対応なしを取り違えない）", () => {
    const files = [
      { path: ["2026.4～アフター進捗管理表（8期）.xlsx"], name: "2026.4～アフター進捗管理表（8期）.xlsx", lastModified: 1 },
      { path: ["2026.4～アフター進捗管理表（現場対応なし）.xlsx"], name: "2026.4～アフター進捗管理表（現場対応なし）.xlsx", lastModified: 1 },
      { path: ["2026.4～年次点検進捗管理表（8期）.xlsx"], name: "2026.4～年次点検進捗管理表（8期）.xlsx", lastModified: 1 },
      { path: ["2026.4～エンド立会管理表（8期）.xlsx"], name: "2026.4～エンド立会管理表（8期）.xlsx", lastModified: 1 },
      { path: ["2025.4～エンド立会管理表（7期）.xlsx"], name: "2025.4～エンド立会管理表（7期）.xlsx", lastModified: 0 },
    ];
    expect(guessFile(files, "after")?.name).toBe("2026.4～アフター進捗管理表（8期）.xlsx");
    expect(guessFile(files, "noSite")?.name).toBe("2026.4～アフター進捗管理表（現場対応なし）.xlsx");
    expect(guessFile(files, "inspection")?.name).toBe("2026.4～年次点検進捗管理表（8期）.xlsx");
    // 同じ種類が2つなら、新しく更新した方
    expect(guessFile(files, "end")?.name).toBe("2026.4～エンド立会管理表（8期）.xlsx");
    expect(guessFile([], "end")).toBeNull();
  });
});
