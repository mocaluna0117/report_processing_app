/**
 * 共有フォルダーに置いた顧客データのファイル（xlsx / csv）を、どう扱うかの規則。純関数のみ。
 *
 * ★2人目が同じ xlsx を手で取り込まなくて済むように、共有フォルダーのファイルを Folio が読む。
 *   **どの取り込み元か（助っ人クラウド／点検保守台帳）はファイルの見出しから自分で分かる**ので、
 *   置く名前は自由（lib/after/import.ts の detectSource）。
 * ★手で取り込む道（ドラッグ＆ドロップ）はそのまま残す。顧客は今後も増えるので、
 *   共有フォルダーを使わない人・新しいファイルを試す人が困らないようにする。
 * ★取り込みは**ファイルが変わったときだけ**（大きさと更新時刻の両方で見る。
 *   Box は書き換えても大きさが変わらないことがある → lib/shared/folder.ts の statChanged と同じ理由）。
 * ★助っ人クラウドの取り込みは**その取り込み元を丸ごと入れ替える**。黙って減らさないよう、
 *   減るときはボタンで確かめてもらう。
 */
import type { CustomerSource } from "@/lib/after/types";

/** 顧客データとして読みにいくファイルの拡張子 */
const CUSTOMER_FILE_EXT = /\.(xlsx|xls|csv)$/i;
/** Excel が開いている間だけ作る一時ファイル（中身は顧客データではない） */
const EXCEL_LOCK_PREFIX = "~$";

export interface FolderFile {
  name: string;
  size: number;
  lastModified: number;
}

/** ファイルの見分け（前に取り込んだときと変わっていないか） */
export interface FileMark {
  size: number;
  lastModified: number;
  /** どの取り込み元だったか。★読み直さずに「同じ取り込み元が2つ」を見つけるために持つ */
  source?: CustomerSource;
  /** Folio がこの端末から置いたファイルか（置き換えるとき、古い方を片付けてよい印） */
  mine?: boolean;
}

/** 名前 → 取り込んだときの見分け */
export type SeenCustomerFiles = Record<string, FileMark>;

export const SOURCE_LABEL: Readonly<Record<CustomerSource, string>> = {
  suketto: "助っ人クラウド",
  dx: "点検保守台帳 (DX)",
};

/**
 * 共有フォルダーの一覧から、顧客データらしいファイルを選ぶ。
 * ★顧客データでないものが混ざっていても、読んだ時点で分かるのでここでは拡張子だけで絞る。
 */
export function pickCustomerFiles(entries: readonly FolderFile[]): FolderFile[] {
  return entries
    .filter((f) => CUSTOMER_FILE_EXT.test(f.name) && !f.name.startsWith(EXCEL_LOCK_PREFIX) && f.size > 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 前に取り込んだときから変わったか（初めて見るファイルも「変わった」） */
export function fileChanged(seen: SeenCustomerFiles, file: FolderFile): boolean {
  const before = seen[file.name];
  if (!before) return true;
  return before.size !== file.size || before.lastModified !== file.lastModified;
}

export const markOf = (
  file: FolderFile,
  source?: CustomerSource,
  mine?: boolean,
): FileMark => ({
  size: file.size,
  lastModified: file.lastModified,
  ...(source ? { source } : {}),
  ...(mine ? { mine: true } : {}),
});

/**
 * 取り込んだ印を書き直す。
 * ★フォルダーから消えたファイルの印は落とす。**顧客は消さない**
 *   （ファイルを片付けただけで台帳が消えたら困る）。
 */
export function keepMarks(seen: SeenCustomerFiles, files: readonly FolderFile[]): SeenCustomerFiles {
  const out: SeenCustomerFiles = {};
  for (const file of files) {
    const mark = seen[file.name];
    if (mark) out[file.name] = mark;
  }
  return out;
}

export function isSeenCustomerFiles(value: unknown): value is SeenCustomerFiles {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (m) =>
      typeof m === "object" &&
      m !== null &&
      typeof (m as FileMark).size === "number" &&
      typeof (m as FileMark).lastModified === "number",
  );
}

/**
 * ★**丸ごと入れ替える取り込み元。**同じ取り込み元のファイルが2つあると、
 *   どちらが勝つかを名前の順で決めることになり、置き間違いに気づけない。
 *   点検保守台帳は物件番号で足し込むだけなので、何個あってもよい。
 */
export const REPLACING_SOURCES: readonly CustomerSource[] = ["suketto"];

/** 同じ取り込み元のファイルが2つ以上あるもの（丸ごと入れ替える取り込み元だけ見る） */
export function conflictingSources(
  entries: readonly { name: string; source: CustomerSource }[],
): { source: CustomerSource; files: string[] }[] {
  const out: { source: CustomerSource; files: string[] }[] = [];
  for (const source of REPLACING_SOURCES) {
    const files = entries
      .filter((e) => e.source === source)
      .map((e) => e.name)
      .sort();
    if (files.length > 1) out.push({ source, files });
  }
  return out;
}

/** どれを使うか決められないときの文（取り込まずに知らせる） */
export function ledgerConflictText(source: CustomerSource, files: readonly string[]): string {
  return (
    `共有フォルダーに${SOURCE_LABEL[source]}のファイルが ${files.length}つ あります（${files.join("・")}）。` +
    `${SOURCE_LABEL[source]}は取り込むと丸ごと入れ替わるので、どれを使うか決められません。` +
    "いちばん新しいもの1つだけを残して、ほかは共有フォルダーから外してください（取り込みは止めています）。"
  );
}

/**
 * 新しいファイルを置いたときに、共有フォルダーから外す古いファイル。
 *
 * ★**丸ごと入れ替える取り込み元（助っ人クラウド）だけ**外す。2つ並ぶと
 *   どちらを使うか決められず、取り込みが止まってしまう。
 * ★**足し込む取り込み元（点検保守台帳）は外さない。** 月ごとの差分を分けて置くので、
 *   古い月を外すと、もう1台にはその月の分が届かなくなる。
 * ★Folio が置いたものか、利用者が手で置いたものかは問わない。どちらも「前の台帳」であり、
 *   残すと行き止まりになるため（外したものは画面に必ず出す）。
 */
export function supersededFiles(
  seen: SeenCustomerFiles,
  source: CustomerSource,
  keepName: string,
): string[] {
  if (!REPLACING_SOURCES.includes(source)) return [];
  return Object.entries(seen)
    .filter(([name, mark]) => mark.source === source && name !== keepName)
    .map(([name]) => name)
    .sort();
}

/** 取り込んだファイルを共有フォルダーにも置けたときの1行 */
export function ledgerPutText(fileName: string, removed: readonly string[]): string {
  const tidy = removed.length > 0 ? `（古い${removed.join("・")}は外しました）` : "";
  return `共有フォルダーに「${fileName}」を置きました${tidy}。もう1台でも同じ台帳になります。`;
}

export type LedgerDecision =
  /** そのまま取り込んでよい */
  | { kind: "import" }
  /** 取り込むと減るので、ボタンで確かめてもらう */
  | { kind: "ask"; text: string };

/**
 * 共有フォルダーのファイルを取り込んでよいか。
 *
 * ★点検保守台帳は PJ で足し込むだけなので消えない → そのまま取り込む。
 * ★助っ人クラウドは**その取り込み元を丸ごと入れ替える**ので、
 *   いまより減るときだけ確かめる（増える・同じなら黙って取り込む）。
 */
export function decideLedgerImport(input: {
  source: CustomerSource;
  fileName: string;
  /** この端末にいる、その取り込み元の顧客の数 */
  existing: number;
  /** ファイルに入っていた顧客の数 */
  incoming: number;
  /** 利用者がボタンで確かめたか */
  confirmed: boolean;
}): LedgerDecision {
  if (input.source !== "suketto") return { kind: "import" };
  if (input.confirmed || input.existing === 0 || input.incoming >= input.existing) {
    return { kind: "import" };
  }
  return {
    kind: "ask",
    text:
      `共有フォルダーの「${input.fileName}」を取り込むと、${SOURCE_LABEL.suketto}の顧客データ ` +
      `${input.existing.toLocaleString()}件 が このファイルの ${input.incoming.toLocaleString()}件 に置き換わります。`,
  };
}

/** 取り込めたときの1行（画面に出す） */
export function ledgerImportedText(input: {
  fileName: string;
  source: CustomerSource;
  added: number;
  updated: number;
  removed: number;
}): string {
  const parts = [`追加 ${input.added.toLocaleString()}件`, `更新 ${input.updated.toLocaleString()}件`];
  if (input.removed > 0) parts.push(`削除 ${input.removed.toLocaleString()}件`);
  return `共有フォルダーの「${input.fileName}」を取り込みました（${SOURCE_LABEL[input.source]}: ${parts.join("・")}）。`;
}
