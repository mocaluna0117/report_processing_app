/**
 * 「使い方」ページの写真の、切り取り範囲と番号の印の位置を出す計算。純関数のみ。
 *
 * ★ここを間違えると12枚すべての印がずれるので、tests/help-shots-geometry.test.ts で固定する
 *   （撮影そのものは Chrome が要るのでテストしない、という既存の方針に合わせた切り分け）。
 */

/** 画面上の箱（CSSピクセル） */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 撮影スクリプトが書き出す、写真1枚ぶんの寸法と印の位置 */
export interface HelpShotGeometry {
  /** 画像の画素数（deviceScaleFactor をかけたあと） */
  width: number;
  height: number;
  /** 画像の左上を (0,0) とした割合(%)。印の中心をここに合わせる */
  hotspots: readonly { x: number; y: number }[];
}

/**
 * いくつかの箱をまとめて囲む範囲。余白を足し、画面からはみ出さないように収める。
 * ★空の配列は呼び出し側の誤り（撮る対象が見つからなかった）なので、黙って 0 を返さずに投げる。
 */
export function unionRect(rects: readonly Rect[], padding = 0, bounds?: Rect): Rect {
  if (rects.length === 0) throw new Error("囲む箱がありません");
  const left = Math.min(...rects.map((r) => r.x)) - padding;
  const top = Math.min(...rects.map((r) => r.y)) - padding;
  const right = Math.max(...rects.map((r) => r.x + r.width)) + padding;
  const bottom = Math.max(...rects.map((r) => r.y + r.height)) + padding;
  const clamped = {
    left: bounds ? Math.max(left, bounds.x) : left,
    top: bounds ? Math.max(top, bounds.y) : top,
    right: bounds ? Math.min(right, bounds.x + bounds.width) : right,
    bottom: bounds ? Math.min(bottom, bounds.y + bounds.height) : bottom,
  };
  return {
    x: clamped.left,
    y: clamped.top,
    width: Math.max(0, clamped.right - clamped.left),
    height: Math.max(0, clamped.bottom - clamped.top),
  };
}

/**
 * 印を置く場所を、切り取り範囲に対する割合(%)にする。
 * at は箱の中のどこを指すか（既定は中央）。小数第1位までに丸め、0〜100 に収める。
 */
export function hotspotPercent(
  target: Rect,
  clip: Rect,
  at: { dx?: number; dy?: number } = {},
): { x: number; y: number } {
  if (clip.width <= 0 || clip.height <= 0) throw new Error("切り取り範囲の大きさがありません");
  const dx = at.dx ?? 0.5;
  const dy = at.dy ?? 0.5;
  const px = target.x + target.width * dx;
  const py = target.y + target.height * dy;
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  return {
    x: clamp(round1(((px - clip.x) / clip.width) * 100)),
    y: clamp(round1(((py - clip.y) / clip.height) * 100)),
  };
}
