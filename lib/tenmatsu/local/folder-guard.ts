/**
 * 顛末書系の保存先を、Box の共有フォルダーの中に選ばせない。
 *
 * ★楽楽精算は**人によって見られる伝票が違う**（権限が分かれている）。取得した PDF を
 *   2人で見える共有フォルダーに置くと、見られないはずの人にも見えてしまい、権限の区別が
 *   意味を失う（利用者の決定 2026-09-23）。共有フォルダーは「データベース」の役割だけにする。
 * ★見分けられるのは **Folio の共有フォルダーとの位置関係だけ**。ブラウザからはフォルダーの
 *   実際の場所（パス）が見えないので、Box の別のフォルダーは見分けられない。
 * ★見分けられないとき（ブラウザが対応していない・調べるのに失敗した）は**止めない**。
 *   確かめようのないことで取得ができなくなるより、分かる範囲で守る。
 */
import type { DocKind } from "@/lib/tenmatsu/kinds";

type Resolve = (possibleDescendant: object) => Promise<string[] | null>;

/**
 * フォルダーの resolve を取り出す（ブラウザの FileSystemDirectoryHandle・検証用の作り物のどちらでも）。
 * 持っていなければ null（古いブラウザ）。
 */
function resolverOf(dir: object): Resolve | null {
  const found = (dir as { resolve?: unknown }).resolve;
  return typeof found === "function" ? (found as Resolve).bind(dir) : null;
}

export type SharedOverlap =
  /** 保存先が共有フォルダーそのもの、またはその中 */
  | "inside-shared"
  /** 保存先の中に共有フォルダーがある（＝保存先が Box の中にあると考えられる） */
  | "contains-shared"
  | null;

/** 保存先と共有フォルダーの位置関係 */
export async function sharedOverlap(saveDir: object, sharedDir: object | null): Promise<SharedOverlap> {
  if (!sharedDir) return null;
  try {
    const fromShared = resolverOf(sharedDir);
    if (fromShared && (await fromShared(saveDir)) !== null) return "inside-shared";
    const fromSave = resolverOf(saveDir);
    if (fromSave && (await fromSave(sharedDir)) !== null) return "contains-shared";
  } catch {
    // ★調べられないときは止めない（上の★を参照）
  }
  return null;
}

/** 選ばせないときの文。どうすればよいかまで書く */
export function sharedOverlapText(kind: DocKind, overlap: Exclude<SharedOverlap, null>): string {
  const where =
    overlap === "inside-shared"
      ? "このフォルダーは Box の共有フォルダー（Folio が顧客データなどを置く場所）の中です。"
      : "このフォルダーの中に Box の共有フォルダーがあります（Box の中のフォルダーのようです）。";
  return (
    `${where}楽楽精算は人によって見られる伝票が違うので、取得した${kind.label}のPDFを共有の場所に置くと、` +
    "見られないはずの人にも見えてしまいます。PC のフォルダー（例: ドキュメントの中）を選んでください。"
  );
}
