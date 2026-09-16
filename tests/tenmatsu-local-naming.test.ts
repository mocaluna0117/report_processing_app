import { describe, expect, it } from "vitest";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import { decideNamedOutputName, decideOutputName, last4, pyStrip, safeComponent, stemOf } from "@/lib/tenmatsu/local/naming";
import { FakeFs } from "./helpers/fake-fs";

// 期待値は移植元 tenmatsu.py の last4 / safe_component / decide_output_path の振る舞いから写した

describe("ファイル名に使える形にする", () => {
  it.each([
    ['見積:テスト/工業*?"<>|.pdf', "見積_テスト_工業______.pdf"],
    ["  顛末書№1234.  ", "顛末書№1234"],
    ["...", "unnamed"],
    ["", "unnamed"],
    ["御見積書（架空邸）", "御見積書（架空邸）"],
    ["\u3000全角の空白\u3000", "全角の空白"],
  ])("「%s」→「%s」", (input, expected) => {
    expect(safeComponent(input)).toBe(expected);
  });

  it("★Python の strip と同じ空白を落とす（JS の trim と違うところ）", () => {
    expect(pyStrip("\x1cA\x85")).toBe("A");
    expect(pyStrip("\ufeffA")).toBe("\ufeffA");
  });

  it("拡張子を除いた名前（Path.stem と同じ）", () => {
    expect(stemOf("御見積書（架空邸）.pdf")).toBe("御見積書（架空邸）");
    expect(stemOf("a.b.c")).toBe("a.b");
    expect(stemOf(".hidden")).toBe(".hidden");
    expect(stemOf("名前だけ")).toBe("名前だけ");
  });

  it("下4桁", () => {
    expect(last4("TE00001476")).toBe("1476");
    expect(last4("AB12")).toBe("AB12");
  });
});

describe("★保存名を決める（上書きは絶対にしない）", () => {
  const setup = () => {
    const fs = new FakeFs();
    return { fs, store: new FolderStore(fs.root) };
  };

  it("{接頭辞}{下4桁}.pdf → 埋まっていればフル伝票№ → _2 … の順", async () => {
    const { fs, store } = setup();
    expect(await decideOutputName(store, [], "TE00001476", "顛末書№")).toBe("顛末書№1476.pdf");
    fs.put("顛末書№1476.pdf", "1");
    expect(await decideOutputName(store, [], "TE00001476", "顛末書№")).toBe("顛末書№TE00001476.pdf");
    fs.put("顛末書№TE00001476.pdf", "1");
    expect(await decideOutputName(store, [], "TE00001476", "顛末書№")).toBe("顛末書№TE00001476_2.pdf");
    fs.put("顛末書№TE00001476_2.pdf", "1");
    expect(await decideOutputName(store, [], "TE00001476", "顛末書№")).toBe("顛末書№TE00001476_3.pdf");
  });

  it("99 まで埋まっていたら例外（黙って上書きしない）", async () => {
    const { fs, store } = setup();
    fs.put("専決決裁書№3001.pdf", "1");
    fs.put("専決決裁書№SE00003001.pdf", "1");
    for (let i = 2; i < 100; i++) fs.put(`専決決裁書№SE00003001_${i}.pdf`, "1");
    await expect(decideOutputName(store, [], "SE00003001", "専決決裁書№")).rejects.toThrow("保存名を決められませんでした");
  });

  it("伝票ごとに決めた名前（捺印決裁書）は _2 から", async () => {
    const { fs, store } = setup();
    expect(await decideNamedOutputName(store, [], "御見積書（架空邸）.pdf")).toBe("御見積書（架空邸）.pdf");
    fs.put("御見積書（架空邸）.pdf", "1");
    expect(await decideNamedOutputName(store, [], "御見積書（架空邸）.pdf")).toBe("御見積書（架空邸）_2.pdf");
  });

  it("別のフォルダーの中で決める", async () => {
    const { fs, store } = setup();
    fs.put("_部品/x/顛末書№1476.pdf", "1");
    expect(await decideOutputName(store, [], "TE00001476", "顛末書№")).toBe("顛末書№1476.pdf");
    expect(await decideOutputName(store, ["_部品", "x"], "TE00001476", "顛末書№")).toBe("顛末書№TE00001476.pdf");
  });
});
