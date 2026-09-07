// 「保留」（添付を結合できなかった伝票）の判断と文言。
//
// 0バイトのPDF・壊れたPDF・パスワード付き・Officeの変換失敗・未対応の形式・取得失敗。
// PC側はこれらでその1件を止めず、本体と結合できた添付だけをまとめて _保留 フォルダへ置く。
// 利用者は欠けた添付を手でPDFにしてここからアップロードし、確定すると正式なフォルダへ入る。
//
// 判定と文言はコンポーネントの外に出して単体テストできるようにする
// (この repo の vitest は node 環境なので、画面の中では確かめられない)。
import type { MissingAttachment } from "@/lib/tenmatsu/client";
import { MAX_PENDING_UPLOAD_BYTES, TenmatsuError } from "@/lib/tenmatsu/client";
import type { DocKind } from "@/lib/tenmatsu/kinds";

/**
 * アップロードできる添付の拡張子。
 * ★PC側の UPLOADABLE_EXTS と対で決めてある。片方だけ増やすと、選べるのに
 *   サーバーが断る（またはその逆）になる。
 */
export const ATTACHMENT_EXTENSIONS = [
  "pdf",
  "jpg",
  "jpeg",
  "png",
  "txt",
  "xlsx",
  "xls",
  "xlsm",
  "docx",
  "doc",
  "pptx",
  "ppt",
  "msg",
] as const;

/** 画面に出す対応形式。PC側のエラー文 (SUPPORTED_ATTACHMENT_TEXT) と同じ並び・同じ文字列 */
export const ATTACHMENT_TYPES_TEXT = ATTACHMENT_EXTENSIONS.map((e) => e.toUpperCase()).join(
  ", ",
);

/** <input type="file"> の accept */
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(",");

/** Dropzone が受け取るファイル名の形 (動画・zip はここで落とす) */
export const ATTACHMENT_PATTERN = new RegExp(`\\.(${ATTACHMENT_EXTENSIONS.join("|")})$`, "i");

/** 選んだファイルのうち、判定に要るものだけ (File に依存させずテストできるように) */
export interface ChosenFile {
  name: string;
  size: number;
}

export interface PendingPlan {
  /** 欠けた添付が全部そろっているか */
  ready: boolean;
  /** まだ選ばれていない添付 */
  unfilled: MissingAttachment[];
  totalBytes: number;
  /** 合計が1回の上限を超えているか */
  tooLarge: boolean;
  /** 元の添付と拡張子が変わるもの (止めはしない。Wordを手でPDFにするのが普通の使い方) */
  extensionChanged: MissingAttachment[];
  /**
   * あとからアップロードする書類がまだ選ばれていないか (捺印決裁書)。
   * true のあいだは「欠けたまま確定」を出さない（入れないと書類として成り立たない）。
   */
  hasAwaiting: boolean;
}

/** あとから利用者がアップロードする書類の置き場か */
export const isAwaiting = (m: MissingAttachment): boolean => m.awaiting === true;

/**
 * 欠けの中にアップロード待ちが含まれるか。
 * ★1つでも含めば「アップロード待ち」と呼ぶ。専決決裁書の本体も欠けた行で
 *   「保留」に戻すと、捺印決裁書だけ否定的な言い方になってしまう。
 */
export function hasAwaiting(missing: readonly MissingAttachment[]): boolean {
  return missing.some(isAwaiting);
}

/** 欠け1つの説明。アップロード待ちは「結合できなかった」ではなく前向きな文にする */
export function missingReasonText(m: MissingAttachment): string {
  return isAwaiting(m)
    ? "あとからアップロードする書類です。ここに入れて確定してください"
    : m.reason;
}

const extOf = (name: string): string => {
  const m = name.match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : "";
};

export function pendingPlan(
  missing: readonly MissingAttachment[],
  chosen: ReadonlyMap<number, ChosenFile>,
): PendingPlan {
  const unfilled = missing.filter((m) => !chosen.has(m.index));
  let totalBytes = 0;
  const extensionChanged: MissingAttachment[] = [];
  for (const m of missing) {
    const file = chosen.get(m.index);
    if (!file) continue;
    totalBytes += file.size;
    // アップロード待ちの枠は元の名前に拡張子が無いので、比べても意味がない
    if (!isAwaiting(m) && extOf(file.name) !== extOf(m.name)) extensionChanged.push(m);
  }
  return {
    ready: unfilled.length === 0,
    unfilled,
    totalBytes,
    tooLarge: totalBytes > MAX_PENDING_UPLOAD_BYTES,
    extensionChanged,
    hasAwaiting: unfilled.some(isAwaiting),
  };
}

const listNames = (items: readonly { name: string }[]): string =>
  items.map((m) => m.name).join("、");

/** 一覧の「保留」「アップロード待ち」バッジに出す説明 */
export function pendingBadgeTitle(missing: readonly MissingAttachment[]): string {
  if (hasAwaiting(missing)) {
    const rest = missing.filter((m) => !isAwaiting(m));
    return (
      "あとからアップロードする書類を入れると確定できます" +
      (rest.length > 0 ? `。結合できなかった添付 (${listNames(rest)}) も足してください` : "")
    );
  }
  return (
    "添付を結合できなかったので保留にしています。" +
    `欠けているのは ${listNames(missing)} です`
  );
}

/** ダイアログの冒頭に出す説明。アップロード待ちが無ければ今までの文と同じ */
export function pendingIntroText(
  kind: DocKind,
  missing: readonly MissingAttachment[],
): string {
  if (!hasAwaiting(missing)) {
    return (
      "本体と結合できた添付は、保留中のPDFに入っています。" +
      `結合できなかったのは次の ${missing.length}件です。` +
      "ファイルを入れて「確定する」を押すと、元の順番で結合して正式なフォルダへ保存します。"
    );
  }
  const rest = missing.filter((m) => !isAwaiting(m)).length;
  return (
    `この${kind.label}には、あとからアップロードする書類が必要です。` +
    (rest > 0 ? `結合できなかった添付も ${rest}件あります。` : "") +
    "下の置き場にファイルを入れて「確定する」を押すと、元の順番で結合して正式なフォルダへ保存します。"
  );
}

/** 一覧の「添付が欠けています」バッジに出す説明 */
export function missingBadgeTitle(missing: readonly MissingAttachment[]): string {
  return (
    "PDFに入っていません: " +
    missing.map((m) => `${m.name} (${missingReasonText(m)})`).join(" / ")
  );
}

export function acceptMissingConfirmText(
  kind: DocKind,
  file: string,
  unfilled: readonly MissingAttachment[],
): string {
  return (
    `${file} を、次の添付が欠けたまま正式なフォルダへ保存します: ${listNames(unfilled)}。\n` +
    `一覧には「添付が欠けています」と残ります。あとから足すことはできません` +
    `(もう一度取り直すには、この${kind.label}の記録を消す必要があります)。よろしいですか？`
  );
}

export function retryConfirmText(kind: DocKind, file: string): string {
  return (
    `${file} の保留を取り消します。保留中のPDFは消え、` +
    `次に「${kind.label}を取得」を押したときに取り直します。よろしいですか？`
  );
}

/**
 * 確定に失敗したときの案内。
 * 結合し直しは数分かかることがあるので、**通信が切れただけかもしれない場合**は
 * 「できなかった」と断定しない (フラグの変更と同じ考え方)。
 */
export function pendingErrorText(definite: boolean, reason: string): string {
  return definite
    ? `確定できませんでした (${reason})`
    : `確定できたか確認できませんでした (${reason})。「一覧を再読み込み」で確かめてください`;
}

/** サーバーが理由を返した失敗か (返していれば「できなかった」と断言してよい) */
export function isDefiniteFailure(e: unknown): boolean {
  return (
    e instanceof TenmatsuError &&
    ["badRequest", "notFound", "auth", "conflict", "tooLarge", "forbidden"].includes(e.kind)
  );
}

export const PENDING_BUSY_TEXT =
  "結合しています… (Office の変換が入ると数分かかることがあります)";
