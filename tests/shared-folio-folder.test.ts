import { describe, expect, it } from "vitest";
import { SENKETSU, TENMATSU } from "@/lib/tenmatsu/kinds";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import {
  copyAcross,
  countFiles,
  defaultKindDirName,
  holdsKindRecords,
  movedText,
  moveInText,
  renamedDirText,
  resolveKindDir,
} from "@/lib/shared/folio-folder";
import { FakeFs } from "./helpers/fake-fs";

// Folio フォルダー1つに、書類ごとのフォルダーをぶら下げる（2026-09-23）。
// ★以前は4か所で別々にフォルダーを選んでいた。共有フォルダーが実質のデータベースに
//   なったので、Folio フォルダーを1回選べば全部そろう形にする。
// ★Box で名前が変えられても行き止まりにしない。記録を手がかりに探して尋ねる。

const setup = (files: Record<string, string> = {}) => {
  const fs = new FakeFs("Folio");
  for (const [path, text] of Object.entries(files)) fs.put(path, text);
  return { fs, store: new FolderStore(fs.root) };
};

describe("書類のフォルダーを決める", () => {
  it("画面に出る名前と同じフォルダーを使う", () => {
    expect(defaultKindDirName(TENMATSU)).toBe("顛末書");
    expect(defaultKindDirName(SENKETSU)).toBe("専決決裁書");
  });

  it("★無ければ作る（選ばせない）", async () => {
    const { fs, store } = setup();
    const state = await resolveKindDir(store, TENMATSU, null);
    expect(state).toEqual({ name: "顛末書", created: true, candidates: [] });
    expect((await store.list([])).map((e) => e.name)).toContain("顛末書");
    expect(fs.files()).toEqual([]);
  });

  it("あればそれを使う", async () => {
    const { store } = setup({ "顛末書/_記録/processed.json": "{}" });
    expect(await resolveKindDir(store, TENMATSU, null)).toEqual({
      name: "顛末書",
      created: false,
      candidates: [],
    });
  });

  it("前に選び直した名前があれば、そちらを先に使う", async () => {
    const { store } = setup({ "顛末書_2026/_記録/processed.json": "{}" });
    expect((await resolveKindDir(store, TENMATSU, "顛末書_2026")).name).toBe("顛末書_2026");
  });
});

describe("★名前が変えられたとき", () => {
  it("記録を手がかりに探して、候補を返す（勝手に切り替えない）", async () => {
    const { store } = setup({ "顛末書_old/_記録/processed.json": "{}" });
    const state = await resolveKindDir(store, TENMATSU, null);
    expect(state.candidates).toEqual(["顛末書_old"]);
    expect(state.created).toBe(false);
  });

  it("★候補があるときはフォルダーを作らない（空の一覧を出して記録が消えたように見せない）", async () => {
    const { store } = setup({ "顛末書_old/_記録/processed.json": "{}" });
    await resolveKindDir(store, TENMATSU, null);
    expect((await store.list([])).map((e) => e.name)).not.toContain("顛末書");
  });

  it("★別の書類のフォルダーは候補にしない（記録が混ざる）", async () => {
    const { store } = setup({ "なにか/_記録/processed_senketsu.json": "{}" });
    expect((await resolveKindDir(store, TENMATSU, null)).candidates).toEqual([]);
    expect((await resolveKindDir(store, SENKETSU, null)).candidates).toEqual(["なにか"]);
  });

  it("_data と、点で始まるフォルダーは見ない", async () => {
    const { store } = setup({ "_data/顧客データ.json": "{}", ".git/x": "y" });
    expect((await resolveKindDir(store, TENMATSU, null)).candidates).toEqual([]);
  });

  it("記録の有無で見分けられる", async () => {
    const { store } = setup({ "A/_記録/processed.json": "{}", "B/なにか.pdf": "x" });
    expect(await holdsKindRecords(store, "A", TENMATSU)).toBe(true);
    expect(await holdsKindRecords(store, "B", TENMATSU)).toBe(false);
  });

  it("どう直せばよいかまで書く", () => {
    const text = renamedDirText(TENMATSU, ["顛末書_old"]);
    expect(text).toContain("顛末書_old");
    expect(text).toContain("名前が変わっていませんか");
    expect(text).toContain("選ぶまで取得はできません");
  });
});

describe("前の保存先からの引っ越し", () => {
  it("★写すだけで、前のフォルダーは消さない", async () => {
    const from = new FakeFs("前の顛末書");
    from.put("顛末書№1476.pdf", "PDF1");
    from.put("_記録/processed.json", "{}");
    const to = new FakeFs("Folio");
    const toStore = new FolderStore(to.root);

    const copied = await copyAcross(new FolderStore(from.root), toStore);
    expect(copied).toBe(2);
    expect(to.files().sort()).toEqual(["_記録/processed.json", "顛末書№1476.pdf"]);
    // ★前のフォルダーはそのまま
    expect(from.files().sort()).toEqual(["_記録/processed.json", "顛末書№1476.pdf"]);
  });

  it("★移し先に同じ名前があれば上書きしない", async () => {
    const from = new FakeFs("前");
    from.put("顛末書№1476.pdf", "前のPDF");
    const to = new FakeFs("Folio");
    to.put("顛末書№1476.pdf", "いまのPDF");

    await copyAcross(new FolderStore(from.root), new FolderStore(to.root));
    expect(to.text("顛末書№1476.pdf")).toBe("いまのPDF");
  });

  it("件数を数えられる（案内に出す）", async () => {
    const { store } = setup({ "顛末書/a.pdf": "1", "顛末書/_記録/processed.json": "{}", "b.pdf": "2" });
    expect(await countFiles(store)).toBe(3);
    expect(await countFiles(store, ["顛末書"])).toBe(2);
  });

  it("案内には、移す前も移したあとも「消していない」と書く", () => {
    expect(moveInText(TENMATSU, "Documents/顛末書", 12)).toContain("移すまで前のフォルダーは消しません");
    expect(movedText(TENMATSU, 12)).toContain("そのまま残してある");
  });
});
