"use client";

/**
 * 問い合わせに付ける写真を、ブラウザの中で縮める（canvas で描き直して JPEG にする）。
 * ★描き直すので、写真に付いている撮影情報（位置など）も消える。
 * ★Vercel の関数が受け取れるのは 4.5MB まで。1枚 1.5MB に収まるまで、段階的に小さくする。
 */
import { CONTACT_LIMITS } from "@/lib/contact/form";
import { fitWithin } from "@/lib/contact/images";

/** 試す順（長い辺, 品質） */
const STEPS: readonly [number, number][] = [
  [CONTACT_LIMITS.photoEdge, 0.85],
  [CONTACT_LIMITS.photoEdge, 0.7],
  [1_280, 0.7],
  [1_024, 0.6],
];

export class PhotoError extends Error {}

export async function compressPhoto(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PhotoError("写真として読めませんでした（PNG・JPEG・WebP の画像を付けてください）");
  }
  try {
    for (const [edge, quality] of STEPS) {
      const { width, height } = fitWithin(bitmap.width, bitmap.height, edge);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      // 透明な部分（PNG）は白にする（JPEG は透明を持てず、黒くなるため）
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= CONTACT_LIMITS.photoBytes) return { blob, width, height };
    }
  } finally {
    bitmap.close();
  }
  throw new PhotoError("写真が大きすぎて縮められませんでした。範囲を狭めて撮り直してください");
}
