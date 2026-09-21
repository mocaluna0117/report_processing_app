import { describe, expect, it } from "vitest";
import { type Rect, hotspotPercent, unionRect } from "@/lib/help-shots-geometry";

// 「使い方」ページの写真は、ここの計算だけで切り取り範囲と印の位置が決まる。
// 間違えると12枚すべての印がずれるので、境目の値まで固定する。

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

describe("いくつかの箱をまとめて囲む", () => {
  it("2つの箱の外側をとる", () => {
    expect(unionRect([rect(10, 20, 100, 50), rect(200, 10, 40, 200)])).toEqual(rect(10, 10, 230, 200));
  });

  it("余白を足す", () => {
    expect(unionRect([rect(50, 50, 100, 100)], 8)).toEqual(rect(42, 42, 116, 116));
  });

  it("★画面の外にはみ出さない（余白を足しても負の座標にしない）", () => {
    const viewport = rect(0, 0, 1280, 900);
    expect(unionRect([rect(4, 4, 100, 100)], 16, viewport)).toEqual(rect(0, 0, 120, 120));
    expect(unionRect([rect(1200, 800, 100, 200)], 16, viewport)).toEqual(rect(1184, 784, 96, 116));
  });

  it("囲む箱が無ければ投げる（撮る対象が見つからなかった、を黙って通さない）", () => {
    expect(() => unionRect([])).toThrow();
  });
});

describe("印の位置を割合にする", () => {
  const clip = rect(100, 50, 400, 200);

  it("既定では箱の中央を指す", () => {
    expect(hotspotPercent(rect(180, 90, 40, 20), clip)).toEqual({ x: 25, y: 25 });
  });

  it("箱の中のどこを指すかを変えられる", () => {
    expect(hotspotPercent(rect(100, 50, 400, 200), clip, { dx: 0, dy: 0 })).toEqual({ x: 0, y: 0 });
    expect(hotspotPercent(rect(100, 50, 400, 200), clip, { dx: 1, dy: 1 })).toEqual({ x: 100, y: 100 });
  });

  it("★切り取り範囲の外に出たら端に寄せる（画像の外に印が飛ばない）", () => {
    expect(hotspotPercent(rect(0, 0, 10, 10), clip)).toEqual({ x: 0, y: 0 });
    expect(hotspotPercent(rect(900, 900, 10, 10), clip)).toEqual({ x: 100, y: 100 });
  });

  it("小数第1位までに丸める（撮り直すたびに末尾がぶれないように）", () => {
    expect(hotspotPercent(rect(233, 50, 0, 0), clip)).toEqual({ x: 33.3, y: 0 });
  });

  it("大きさの無い切り取り範囲は投げる", () => {
    expect(() => hotspotPercent(rect(0, 0, 10, 10), rect(0, 0, 0, 100))).toThrow();
  });
});
