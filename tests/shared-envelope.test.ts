import { describe, expect, it } from "vitest";
import { SHARED_DATASETS, backupName } from "@/lib/shared/datasets";
import {
  SharedCorruptError,
  SharedVersionError,
  formatEnvelope,
  formatItems,
  parseEnvelope,
  stableStringify,
} from "@/lib/shared/envelope";

// 共有フォルダーに置く JSON の封筒（2026-09-22）。
// ★「変わっていないなら書かない」ための同じ形の整え方と、壊れた・別の種類・新しい版の見分け。

const DATASET = SHARED_DATASETS["customer-edits"];
const isAny = (_v: unknown): _v is Record<string, unknown> => true;

describe("同じ形に整える", () => {
  it("★キーの順番が違っても同じ文字列になる（変わっていないかを文字列で見るため）", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("配列の順番は変えない（手本は取り込んだ順に意味がある）", () => {
    expect(formatItems([2, 1, 3])).not.toBe(formatItems([1, 2, 3]));
  });

  it("値の無い項目は書かない", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

describe("封筒を書く", () => {
  it("種類・版・時刻（UTC）・書いた端末を添える", () => {
    const text = formatEnvelope(DATASET, { "dx:2101230101": 1 }, "device-1", 1_758_000_000_000);
    const parsed = JSON.parse(text);
    expect(parsed.kind).toBe("folio/customer-edits");
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.writer).toBe("device-1");
    // ★UTC の ISO（PCの時差設定に左右されない）
    expect(parsed.updatedAt).toBe(new Date(1_758_000_000_000).toISOString());
    expect(parsed.updatedAt).toMatch(/Z$/);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("書いたものをそのまま読み返せる", () => {
    const items = { "dx:2101230101": { memo: "架空のメモ" } };
    const text = formatEnvelope(DATASET, items, "device-1", 1);
    expect(parseEnvelope(DATASET, text, isAny).items).toEqual(items);
  });

  it("控えのファイル名は .bak を足したもの（1世代だけ）", () => {
    expect(backupName("顧客の手直し.json")).toBe("顧客の手直し.json.bak");
  });
});

describe("読めないファイルは止める（自分で直さない）", () => {
  const fail = (text: string) => {
    try {
      parseEnvelope(DATASET, text, isAny);
    } catch (e) {
      return e;
    }
    throw new Error("失敗するはずが成功しました");
  };

  it("空・壊れた JSON・配列", () => {
    expect(fail("")).toBeInstanceOf(SharedCorruptError);
    expect(fail("   ")).toBeInstanceOf(SharedCorruptError);
    expect(fail("{壊れ")).toBeInstanceOf(SharedCorruptError);
    expect(fail("[1,2]")).toBeInstanceOf(SharedCorruptError);
  });

  it("★別の種類のファイル（取り違え）は読まない", () => {
    const other = formatEnvelope(SHARED_DATASETS["examples-inquiry"], { items: [], deleted: {} }, "d", 1);
    const error = fail(other);
    expect(error).toBeInstanceOf(SharedCorruptError);
    expect((error as Error).message).toContain("別の種類");
  });

  it("★新しい版のファイルは読まない（古い Folio が書き換えて壊さないため）", () => {
    const text = JSON.stringify({ ...JSON.parse(formatEnvelope(DATASET, {}, "d", 1)), schemaVersion: 2 });
    const error = fail(text);
    expect(error).toBeInstanceOf(SharedVersionError);
    expect((error as SharedVersionError).found).toBe(2);
    expect((error as Error).message).toContain("新しくしてください");
  });

  it("中身の形が違えば読まない", () => {
    const isNumber = (v: unknown): v is number => typeof v === "number";
    expect(() => parseEnvelope(DATASET, formatEnvelope(DATASET, {}, "d", 1), isNumber)).toThrow(
      SharedCorruptError,
    );
  });

  it("先頭に目印（BOM）が付いていても読める（ほかのアプリが保存し直した場合）", () => {
    const text = `﻿${formatEnvelope(DATASET, { a: 1 }, "d", 1)}`;
    expect(parseEnvelope(DATASET, text, isAny).items).toEqual({ a: 1 });
  });
});
