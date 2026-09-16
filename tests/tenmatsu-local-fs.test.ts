import { describe, expect, it } from "vitest";
import { FolderError, FolderStore } from "@/lib/tenmatsu/local/fs";
import { FakeFs } from "./helpers/fake-fs";

const setup = () => {
  const fs = new FakeFs();
  return { fs, store: new FolderStore(fs.root) };
};

async function folderError(promise: Promise<unknown>): Promise<FolderError> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof FolderError) return e;
    throw e;
  }
  throw new Error("失敗するはずが、通ってしまった");
}

describe("選んだフォルダーの読み書き", () => {
  it("フォルダーを作りながら書き、読める", async () => {
    const { fs, store } = setup();
    await store.writeBytes(["_保留", "TE00009103", "000_本体.pdf"], new Uint8Array([1, 2, 3]));
    expect(fs.files()).toEqual(["_保留/TE00009103/000_本体.pdf"]);
    expect(await store.readBytes(["_保留", "TE00009103", "000_本体.pdf"])).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.name).toBe("顛末書");
  });

  it("文字は UTF-8 で書き、先頭に BOM があっても読める", async () => {
    const { fs, store } = setup();
    fs.put("_記録/processed.json", "\ufeff{\"done\": []}");
    expect(await store.readText(["_記録", "processed.json"])).toBe('{"done": []}');
  });

  it("あるか・何かを見分ける。無いものは null", async () => {
    const { fs, store } = setup();
    fs.put("a/b.pdf", "x");
    expect(await store.stat(["a", "b.pdf"])).toMatchObject({ kind: "file", size: 1 });
    expect((await store.stat(["a"]))?.kind).toBe("directory");
    expect(await store.stat(["a", "無い.pdf"])).toBeNull();
    expect(await store.stat(["無い", "b.pdf"])).toBeNull();
    expect(await store.exists(["a", "b.pdf"])).toBe(true);
  });

  it("中身の一覧は名前順。無いフォルダーは空", async () => {
    const { fs, store } = setup();
    fs.put("_保留/B/x", "1");
    fs.put("_保留/A/x", "1");
    fs.put("_保留/c.txt", "1");
    expect(await store.list(["_保留"])).toEqual([
      { name: "A", kind: "directory" },
      { name: "B", kind: "directory" },
      { name: "c.txt", kind: "file" },
    ]);
    expect(await store.list(["無い"])).toEqual([]);
  });

  it("消す。無ければ何もしない。中身のあるフォルダーは recursive が要る", async () => {
    const { fs, store } = setup();
    fs.put("d/x.pdf", "1");
    await store.remove(["無い"]);
    expect((await folderError(store.remove(["d"]))).kind).toBe("conflict");
    await store.remove(["d"], { recursive: true });
    expect(fs.files()).toEqual([]);
  });

  it("★保存先フォルダーそのものは消させない", async () => {
    const { store } = setup();
    expect((await folderError(store.remove([], { recursive: true }))).kind).toBe("invalidName");
  });

  it("★移すときは移し先を先に消す（中へ入れてしまわない）", async () => {
    const { fs, store } = setup();
    fs.put("_work/TE1/000_本体.pdf", "new");
    fs.put("_保留/TE1/古い部品.pdf", "old");
    await store.moveDir(["_work", "TE1"], ["_保留", "TE1"]);
    expect(fs.files()).toEqual(["_保留/TE1/000_本体.pdf"]);
    expect(fs.text("_保留/TE1/000_本体.pdf")).toBe("new");
  });

  it("★書いている途中で失敗したら、元のファイルはそのまま", async () => {
    const { fs, store } = setup();
    fs.put("_記録/processed.json", "元の内容");
    fs.failClose("_記録/processed.json");
    await expect(store.writeBytes(["_記録", "processed.json"], "新しい内容")).rejects.toBeInstanceOf(FolderError);
    expect(fs.text("_記録/processed.json")).toBe("元の内容");
  });

  it("★ほかのアプリで開いていて書けないときは、閉じてからと案内する", async () => {
    const { fs, store } = setup();
    fs.put("顛末書№9101.pdf", "1");
    fs.lock("顛末書№9101.pdf");
    const error = await folderError(store.writeBytes(["顛末書№9101.pdf"], "2"));
    expect(error.kind).toBe("conflict");
    expect(error.message).toContain("閉じてから");
    expect(fs.text("顛末書№9101.pdf")).toBe("1");
  });

  it("★許可が無いときは「フォルダーにつなぐ」と案内する", async () => {
    const { fs, store } = setup();
    fs.deny();
    const error = await folderError(store.writeBytes(["a.pdf"], "1"));
    expect(error.kind).toBe("permission");
    expect(error.message).toContain("フォルダーにつなぐ");
  });

  it("★フォルダーそのものが無くなったら、選び直すよう案内する", async () => {
    const { fs, store } = setup();
    await store.probe();
    fs.vanish();
    const error = await folderError(store.probe());
    expect(error.kind).toBe("folderMissing");
    expect(error.message).toContain("選び直して");
  });

  it.each([[""], ["."], [".."], ["a/b"], ["a\\b"]])("名前「%s」は使わせない", async (name) => {
    const { store } = setup();
    expect((await folderError(store.writeBytes(["_保留", name], "1"))).kind).toBe("invalidName");
  });

  it("フォルダーを中身ごと写す", async () => {
    const { fs, store } = setup();
    fs.put("_部品/N1/manifest.json", "{}");
    fs.put("_部品/N1/000_01_見積.pdf", "p");
    await store.copyDir(["_部品", "N1"], ["_作業", "N1"]);
    expect(fs.files()).toEqual([
      "_作業/N1/000_01_見積.pdf",
      "_作業/N1/manifest.json",
      "_部品/N1/000_01_見積.pdf",
      "_部品/N1/manifest.json",
    ]);
  });
});
