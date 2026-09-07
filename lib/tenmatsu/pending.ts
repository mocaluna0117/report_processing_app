// 「保留」（添付を結合できなかった伝票）の判断と文言。
//
// 0バイトのPDF・壊れたPDF・パスワード付き・Officeの変換失敗・未対応の形式・取得失敗。
// PC側はこれらでその1件を止めず、本体と結合できた添付だけをまとめて _保留 フォルダへ置く。
// 利用者は欠けた添付を手でPDFにしてここからアップロードし、確定すると正式なフォルダへ入る。
//
// 判定と文言はコンポーネントの外に出して単体テストできるようにする
// (この repo の vitest は node 環境なので、画面の中では確かめられない)。
import type { ListItem, MissingAttachment, UploadSlot } from "@/lib/tenmatsu/client";
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
  /**
   * すでにPC側に入っているファイルを残す指定 (値は upload_slots[].files[].file)。
   * ★これが入っているものは中身を送らないので、1回の上限にも数えない。
   */
  kept?: string;
}

/** 枠ごとの中身 (index → 並び順のファイル)。1つしか入らない枠は要素1つ */
export type ChosenMap = ReadonlyMap<number, readonly ChosenFile[]>;

/** すでに入っているものを残す指定か */
export const isKept = (f: ChosenFile): boolean => typeof f.kept === "string";

/**
 * その枠に複数のファイルを入れられるか。
 * ★files を返さないサーバーは1つしか受け取れない (同じ枠に複数送ると最後の1つだけ残る)。
 *   そこで、この項目が無いときは画面でも1つに制限する。
 */
export const allowsMultiple = (m: MissingAttachment): boolean =>
  m.awaiting === true && m.files !== undefined;

/** 枠の初期状態。すでに入っているファイルを「残す」指定として並べる */
export function initialChosen(missing: readonly MissingAttachment[]): Map<number, ChosenFile[]> {
  const out = new Map<number, ChosenFile[]>();
  for (const m of missing) {
    const files = m.files ?? [];
    if (files.length > 0) {
      out.set(
        m.index,
        files.map((f) => ({ name: f.name, size: f.size ?? 0, kept: f.file })),
      );
    }
  }
  return out;
}

/** 確定した伝票の枠を、ダイアログが扱う形 (missing) に直す */
export function slotsAsMissing(item: ListItem): MissingAttachment[] {
  return (item.upload_slots ?? []).map((slot: UploadSlot) => ({
    index: slot.index,
    name: slot.name,
    reason: "",
    awaiting: true,
    files: slot.files,
  }));
}

/**
 * 差し替えのダイアログに出す枠。
 * 書類の枠（必須）に加えて、**欠けたまま確定した添付**も出して、あとから足せるようにする
 * （足さなくても確定できるので optional を付ける）。並びは index の順。
 */
export function recomposeMissing(item: ListItem): MissingAttachment[] {
  const failed = (item.missing_attachments ?? []).map((m) => ({ ...m, optional: true }));
  return [...slotsAsMissing(item), ...failed].sort((a, b) => a.index - b.index);
}

/** 1つ上げる / 下げる (端なら元の並びのまま返す)。★元の配列は変えない */
export function moveEntry<T>(list: readonly T[], at: number, dir: -1 | 1): T[] {
  const to = at + dir;
  if (at < 0 || at >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}

/** 1つ外す。★元の配列は変えない */
export function removeEntry<T>(list: readonly T[], at: number): T[] {
  return list.filter((_, i) => i !== at);
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
  if (isAwaiting(m)) return "あとからアップロードする書類です。ここに入れて確定してください";
  // 欠けたまま確定した添付。ここで足せるが、足さなくても組み直せる
  return m.optional ? `${m.reason}（入れなくても組み直せます）` : m.reason;
}

const extOf = (name: string): string => {
  const m = name.match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : "";
};

export function pendingPlan(
  missing: readonly MissingAttachment[],
  chosen: ChosenMap,
): PendingPlan {
  // ★すでにPC側へ入っているもの (filled) はそのまま確定できるので、欠けとは数えない
  const unfilled = missing.filter(
    (m) => (chosen.get(m.index) ?? []).length === 0 && !m.filled && !m.optional,
  );
  let totalBytes = 0;
  const extensionChanged: MissingAttachment[] = [];
  for (const m of missing) {
    const files = chosen.get(m.index) ?? [];
    for (const file of files) {
      // 残すだけのものは送らないので数えない
      if (!isKept(file)) totalBytes += file.size;
      // アップロード待ちの枠は元の名前に拡張子が無いので、比べても意味がない
      if (!isAwaiting(m) && extOf(file.name) !== extOf(m.name)) extensionChanged.push(m);
    }
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
    const held = missing.filter(isAwaiting).flatMap((m) => m.files ?? []);
    return (
      (held.length > 0
        ? `入れてある書類 ${held.length}件 (${listNames(held)})。確定すると1つのPDFにします`
        : "あとからアップロードする書類を入れると確定できます") +
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
    "一覧には「添付が欠けています」と残ります。" +
    (kind.canRecompose
      ? "あとから「差し替え」で足すこともできます。"
      : "あとから足すことはできません" +
        `(もう一度取り直すには、この${kind.label}の記録を消す必要があります)。`) +
    "よろしいですか？"
  );
}

/** 枠の一覧に添える説明 (複数入れられるとき) */
export function slotHintText(count: number, multiple: boolean): string {
  if (!multiple) {
    return "この置き場に入れられるのは1つです (PCのツールを更新すると複数入れられます)";
  }
  return count === 0
    ? "ここに入れた書類が、この順番でPDFの先頭に入ります (複数入れられます)"
    : `入れた書類 ${count}件。この順番でPDFの先頭に入ります (↑↓で並べ替え、外すで取り消し)`;
}

/** 確定したあとの差し替えダイアログの冒頭 */
export function recomposeIntroText(kind: DocKind, missingCount = 0): string {
  return (
    `保存済みの${kind.label}を、下の並びで組み直します。` +
    "書類を外す・足す・並べ替えてから「確定する」を押すと、同じファイル名で書き直します。" +
    (missingCount > 0
      ? `欠けたまま確定した添付 ${missingCount}件も、ここで足せます。`
      : "") +
    "「確定する」を押すまで、保存されているPDFは変わりません。"
  );
}

export function recomposeConfirmText(kind: DocKind, file: string, marks: string): string {
  return (
    `${file} を下の並びで組み直します。\n` +
    `中身が変わるので、${marks}は外れます (クラウドへ入れ直してください)。\n` +
    `よろしいですか？`
  );
}

/** 「差し替え」を押せないときの理由。null なら押せる */
export function recomposeDisabledReason(
  item: { upload_slots?: unknown; exists?: boolean },
  busyReason: string | null,
): string | null {
  if (busyReason) return busyReason;
  if (item.upload_slots === undefined) {
    return "このPCのサーバーは書類の差し替えに未対応です (~/tenmatsu-dl/ を更新してください)";
  }
  if (item.upload_slots === null) {
    return "この記録には部品が残っていないので差し替えられません (この機能より前に取得したものです)";
  }
  return null;
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

/** 一覧の「差し替え済み」バッジに出す説明 */
export function recomposedBadgeTitle(at: string, marks: string): string {
  return `${at} に入れた書類を差し替えて組み直しました (${marks}は外してあります)`;
}

export const PENDING_BUSY_TEXT =
  "結合しています… (Office の変換が入ると数分かかることがあります)";
