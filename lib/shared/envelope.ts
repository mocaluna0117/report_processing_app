/**
 * 共有フォルダーに置く JSON の「封筒」。純関数のみ。
 *
 * ★中身（items）は**キーを並べ替えて同じ形に整える**。こうすると「前と同じ内容か」を
 *   文字列の比較で判定でき、**変わっていないときは書かずに済む**（控え .bak を無駄に上書きしない）。
 * ★知らない版（schemaVersion）のファイルは**読まず・書かない**。新しい Folio が書いた形を
 *   古い Folio が壊さないため。
 * ★壊れたファイルは**自分で直さない**。止めて、控えの場所を利用者に伝える
 *   （顛末書の _記録 と同じ流儀。勝手に直すと、直した結果が正本として相手にも配られる）。
 */
import type { SharedDataset } from "@/lib/shared/datasets";

export interface SharedEnvelope<T> {
  schemaVersion: number;
  /** データの種類（取り違えを止める目印） */
  kind: string;
  /** 最後に書いた日時。★UTC の ISO（PCの時差設定に左右されないため） */
  updatedAt: string;
  /** 最後に書いた端末の目印（乱数。氏名やPC名は入れない） */
  writer: string;
  items: T;
}

/** 読めなかった（壊れている・別の種類だった）。★書かずに止める */
export class SharedCorruptError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(message);
    this.name = "SharedCorruptError";
  }
}

/** 知らない版だった。★書かずに止める（新しい Folio の書いた形を壊さない） */
export class SharedVersionError extends Error {
  constructor(
    readonly file: string,
    readonly found: number,
    message: string,
  ) {
    super(message);
    this.name = "SharedVersionError";
  }
}

/**
 * キーを並べ替えて JSON にする（同じ内容なら必ず同じ文字列になる）。
 * 配列の順番は変えない（学習の手本は取り込んだ順に意味がある）。
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    // undefined の項目は書かない（JSON.stringify と同じ扱いにそろえる）
    if (source[key] !== undefined) out[key] = sortKeys(source[key]);
  }
  return out;
}

/** 中身だけを同じ形に整える（「変わっていないか」の判定に使う） */
export const formatItems = (items: unknown): string => stableStringify(items);

/** ファイルに書く文字列を作る */
export function formatEnvelope<T>(
  dataset: SharedDataset,
  items: T,
  writer: string,
  now: number,
): string {
  const envelope: SharedEnvelope<T> = {
    schemaVersion: dataset.schemaVersion,
    kind: dataset.kind,
    updatedAt: new Date(now).toISOString(),
    writer,
    items,
  };
  return `${stableStringify(envelope)}\n`;
}

/**
 * ファイルの文字列を読む。
 *
 * 中身の取り出しは種類ごとの `pick` に任せる。
 * ★`pick` は「読めたら中身、まるごと形が違えば null」を返す。
 *   1件だけ形が違うようなものは `pick` の中で落とす（1件の不備で全部を捨てない）。
 */
export function parseEnvelope<T>(
  dataset: SharedDataset,
  text: string,
  pick: (value: unknown) => T | null,
): SharedEnvelope<T> {
  // ほかのアプリが保存し直していても読めるように、先頭の目印（BOM）を落とす
  const body = text.replace(/^﻿/, "").trim();
  if (body === "") {
    throw new SharedCorruptError(dataset.file, `${dataset.file} が空です`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SharedCorruptError(
      dataset.file,
      `${dataset.file} を読めませんでした（JSON として壊れています）`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SharedCorruptError(dataset.file, `${dataset.file} の形が違います`);
  }
  const envelope = parsed as Partial<SharedEnvelope<unknown>>;
  if (envelope.kind !== dataset.kind) {
    throw new SharedCorruptError(
      dataset.file,
      `${dataset.file} は別の種類のファイルです（${String(envelope.kind ?? "種類なし")}）`,
    );
  }
  if (typeof envelope.schemaVersion !== "number") {
    throw new SharedCorruptError(dataset.file, `${dataset.file} に版が入っていません`);
  }
  if (envelope.schemaVersion > dataset.schemaVersion) {
    throw new SharedVersionError(
      dataset.file,
      envelope.schemaVersion,
      `${dataset.file} は新しい Folio が書いた形です（版 ${envelope.schemaVersion}）。` +
        "この端末の Folio を新しくしてください（古いままでは書き換えません）",
    );
  }
  const items = pick(envelope.items);
  if (items === null) {
    throw new SharedCorruptError(dataset.file, `${dataset.file} の中身の形が違います`);
  }
  return {
    schemaVersion: envelope.schemaVersion,
    kind: dataset.kind,
    updatedAt: typeof envelope.updatedAt === "string" ? envelope.updatedAt : "",
    writer: typeof envelope.writer === "string" ? envelope.writer : "",
    items,
  };
}
