import { describe, expect, it } from "vitest";
import { EMPTY_CONTACT, setContactPhone } from "@/lib/contacts";
import type { Contact } from "@/lib/types";

// 架空の番号のみ (実在の連絡先は使わない)
const c = (phone: string, relation = "", confidence: Contact["confidence"] = "ok"): Contact => ({
  phone,
  relation,
  confidence,
});

describe("setContactPhone", () => {
  it("連絡先①を入れる", () => {
    expect(setContactPhone([], 0, "090-0000-1234")).toEqual([c("090-0000-1234")]);
  });

  it("①が無いまま②だけ入れると、①は空欄で場所を保つ", () => {
    expect(setContactPhone([], 1, "03-0000-5678")).toEqual([
      EMPTY_CONTACT,
      c("03-0000-5678"),
    ]);
  });

  it("①を消しても②は②のまま (番号が繰り上がらない)", () => {
    const before = [c("090-0000-1234"), c("03-0000-5678", "奥様")];
    expect(setContactPhone(before, 0, "")).toEqual([EMPTY_CONTACT, c("03-0000-5678", "奥様")]);
    // 続柄が付いていた欄を消した場合は、続柄だけ残る
    const withRelation = [c("090-0000-1234", "ご主人"), c("03-0000-5678", "奥様")];
    expect(setContactPhone(withRelation, 0, "")[0]).toEqual({
      phone: "",
      relation: "ご主人",
      confidence: "ok",
    });
  });

  it("①②とも消したら空になる (末尾の空欄は持たない)", () => {
    const before = [c("090-0000-1234"), c("03-0000-5678")];
    const one = setContactPhone(before, 1, "");
    expect(one).toEqual([c("090-0000-1234")]);
    expect(setContactPhone(one, 0, "　")).toEqual([]);
  });

  it("番号だけ直したら、もとの続柄を残す", () => {
    const before = [c("090-0000-1234", "ご主人")];
    expect(setContactPhone(before, 0, "090-0000-9999")).toEqual([
      c("090-0000-9999", "ご主人"),
    ]);
  });

  it("番号を消してから打ち直しても続柄は残る (1文字ずつ書き戻すため)", () => {
    let contacts: Contact[] = [c("090-1111-2222", "奥様"), c("080-3333-4444", "ご主人")];
    // 入力欄を空にした状態を通る
    contacts = setContactPhone(contacts, 0, "");
    expect(contacts[0]).toEqual({ phone: "", relation: "奥様", confidence: "ok" });
    // 1文字ずつ打ち直す
    for (const text of ["0", "09", "090", "090-9999-8888"]) {
      contacts = setContactPhone(contacts, 0, text);
    }
    expect(contacts[0].relation).toBe("奥様");
    expect(contacts[1]).toEqual(c("080-3333-4444", "ご主人"));
  });

  it("括弧付きの続柄を書けば続柄も差し替わる", () => {
    const before = [c("090-0000-1234", "ご主人")];
    expect(setContactPhone(before, 0, "090-0000-1234（奥様）")).toEqual([
      c("090-0000-1234", "奥様"),
    ]);
  });

  it("ハイフン無しの11桁は整えて要確認にする", () => {
    expect(setContactPhone([], 0, "09000001234")).toEqual([
      c("090-0000-1234", "", "warn"),
    ]);
  });

  it("番号として読めない文字列は消さず要確認で残す", () => {
    const before = [c("090-0000-1234", "奥様")];
    expect(setContactPhone(before, 0, "不明")).toEqual([c("不明", "奥様", "warn")]);
  });
});
