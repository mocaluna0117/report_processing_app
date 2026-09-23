import { describe, expect, it } from "vitest";
import { TENMATSU } from "@/lib/tenmatsu/kinds";
import { sharedOverlap, sharedOverlapText } from "@/lib/tenmatsu/local/folder-guard";
import { FakeFs } from "./helpers/fake-fs";

// 顛末書系の保存先を、Box の共有フォルダーの中に選ばせない（2026-09-23）。
// ★楽楽精算は人によって見られる伝票が違う。取得した PDF を2人で見える場所に置くと、
//   見られないはずの人にも見えてしまう。共有フォルダーは「データベース」の役割だけにする。

/** Box の中を再現する: Box/Folio共有/_data、Box/Folio共有/顛末書、Box/個人/顛末書 */
const setup = async () => {
  const box = new FakeFs("Box");
  const shared = await box.root.getDirectoryHandle("Folio共有", { create: true });
  const insideShared = await shared.getDirectoryHandle("顛末書", { create: true });
  const personal = await box.root.getDirectoryHandle("個人", { create: true });
  const sibling = await personal.getDirectoryHandle("顛末書", { create: true });
  const pc = new FakeFs("ドキュメント");
  const local = await pc.root.getDirectoryHandle("顛末書", { create: true });
  return { box, shared, insideShared, sibling, local };
};

describe("保存先と共有フォルダーの位置関係", () => {
  it("★共有フォルダーの中は選ばせない", async () => {
    const { shared, insideShared } = await setup();
    expect(await sharedOverlap(insideShared, shared)).toBe("inside-shared");
  });

  it("★共有フォルダーそのものも選ばせない", async () => {
    const { shared } = await setup();
    expect(await sharedOverlap(shared, shared)).toBe("inside-shared");
  });

  it("★中に共有フォルダーがある（Box の上のほう）も選ばせない", async () => {
    const { box, shared } = await setup();
    expect(await sharedOverlap(box.root, shared)).toBe("contains-shared");
  });

  it("PC のフォルダーは選べる", async () => {
    const { shared, local } = await setup();
    expect(await sharedOverlap(local, shared)).toBeNull();
  });

  it("★Box の別のフォルダーは見分けられない（パスが見えないため。限界として固定しておく）", async () => {
    const { shared, sibling } = await setup();
    expect(await sharedOverlap(sibling, shared)).toBeNull();
  });

  it("共有フォルダーを選んでいなければ、何も言わない", async () => {
    const { local } = await setup();
    expect(await sharedOverlap(local, null)).toBeNull();
  });

  it("★調べられないブラウザでは止めない（確かめようのないことで取得できなくしない）", async () => {
    const noResolve = {};
    expect(await sharedOverlap(noResolve, noResolve)).toBeNull();
  });

  it("★調べるのに失敗しても止めない", async () => {
    const broken = {
      resolve: async () => {
        throw new Error("失敗");
      },
    };
    expect(await sharedOverlap(broken, broken)).toBeNull();
  });
});

describe("選ばせないときの文", () => {
  it("理由とどうすればよいかを書く", () => {
    const text = sharedOverlapText(TENMATSU, "inside-shared");
    expect(text).toContain("共有フォルダー");
    expect(text).toContain("楽楽精算は人によって見られる伝票が違う");
    expect(text).toContain("顛末書");
    expect(text).toContain("PC のフォルダー");
  });

  it("中に共有フォルダーがあるときは、Box の中らしいと伝える", () => {
    expect(sharedOverlapText(TENMATSU, "contains-shared")).toContain("Box の中のフォルダーのようです");
  });
});
