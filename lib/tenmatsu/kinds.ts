// 書類の種類（顛末書 / 専決決裁書）の設定。
//
// 画面の作りは同じで、違うのは「文言・一覧の列・完了の印・保存先のキー」だけなので、
// その違いだけをここに集める。画面のコンポーネントは種類を1つ受け取って描く。
//
// ★顛末書の値は現状と1対1にしてある（tests/tenmatsu-kinds.test.ts が、いまの画面から
//   写した文字列と突き合わせて守っている）。顛末書の見え方は変えない。
// ★ツール名・batファイル名は種類で言い換えない。実体は1つ（顛末書取得ツール /
//   顛末書サーバー起動.bat）で、専決決裁書タブからも同じものを使うため。
import type { FlagKey, HealthPayload } from "@/lib/tenmatsu/client";
import { type ListFilterDef, LIST_FILTERS } from "@/lib/tenmatsu/list-view";

export type DocKindId = "tenmatsu" | "senketsu";

/** 一覧に出す、楽楽精算から読んだ文字列の項目 */
export type TextField =
  | "title"
  | "property_name"
  | "shinsei_date"
  | "shinseisha"
  | "amount"
  | "payee"
  | "final_approved_at";

/** 右端の固定枠に出す完了の印 */
export interface FlagColumn {
  key: FlagKey;
  /** 枠の見出し */
  head: string;
  /** 読み上げに使う正式名 */
  label: string;
  /** ボタンの文字（見出しに項目名があるので、ボタンは状態だけを書く） */
  todo: string;
  done: string;
}

/** 一覧のデータ列 */
export interface DataColumn {
  head: string;
  field: TextField;
  align?: "right";
}

export interface DocKind {
  id: DocKindId;
  /** リクエストに付ける種類。null なら付けない（顛末書。古いサーバーとの互換） */
  apiKind: DocKindId | null;
  /** 文中に差し込む名詞 */
  label: string;
  route: "/tenmatsu" | "/senketsu";
  menuLabel: string;
  pageTitle: string;
  pageDescription: string;
  /** サーバーが付けるファイル名の接頭辞（folio は付けない。説明用） */
  filePrefix: string;
  /** 監督・営業をお客様の情報へ反映する欄を出すか */
  showStaffSync: boolean;
  flagColumns: readonly FlagColumn[];
  /** flagColumns から作る。配列の同一性を固定するため定義時に1回だけ作る */
  flagKeys: readonly FlagKey[];
  listFilters: readonly ListFilterDef[];
  dataColumns: readonly DataColumn[];
  text: {
    /** 「一覧を消去」の確認に出す、一覧に入っている個人情報 */
    sensitiveFields: string;
    /** 「入力済み・格納済みの印」のような、印のまとめ方 */
    flagMarks: string;
    /** 保存についての説明（全文。区切りや注記が種類で違うので派生させない） */
    storageDescription: string;
    /** 「完了したものも表示」の説明 */
    completedHint: string;
  };
}

const defineKind = (kind: Omit<DocKind, "flagKeys">): DocKind => ({
  ...kind,
  flagKeys: kind.flagColumns.map((c) => c.key),
});

export const TENMATSU: DocKind = defineKind({
  id: "tenmatsu",
  apiKind: null, // 今までどおり kind を付けずに呼ぶ
  label: "顛末書",
  route: "/tenmatsu",
  menuLabel: "顛末書",
  pageTitle: "Folio — 顛末書",
  pageDescription: "顛末書PDFの取得 (このPCのローカルサーバー経由) と取得済み一覧の確認",
  filePrefix: "顛末書No.",
  showStaffSync: true,
  flagColumns: [
    { key: "budget_entered", head: "実行予算", label: "実行予算入力済み", todo: "未入力", done: "入力済み" },
    { key: "cloud_stored", head: "クラウド", label: "クラウド格納済み", todo: "未格納", done: "格納済み" },
  ],
  listFilters: LIST_FILTERS,
  dataColumns: [
    { head: "物件名", field: "property_name" },
    { head: "申請日", field: "shinsei_date" },
    { head: "申請者", field: "shinseisha" },
    { head: "支払金額(税込)", field: "amount", align: "right" },
    { head: "支払先", field: "payee" },
    { head: "最終承認日", field: "final_approved_at" },
  ],
  text: {
    sensitiveFields: "物件名・申請者・支払先・支払金額",
    flagMarks: "入力済み・格納済みの印",
    completedHint: "実行予算入力済みとクラウド格納済みの両方にチェックが付いた行のことです",
    storageDescription:
      "顛末書の取得済み一覧には、伝票No.・物件名 (施主名を含むことがあります)・申請者・支払先・支払金額・入力済み/格納済みの印が入ります。これらはローカルサーバーのトークン・1回に取る件数とあわせて、このブラウザ内にだけ保存され、folio のサーバーには送信されません。印の正本はPCの記録で、この一覧はその写しです (消しても再接続すれば戻ります)。PDFの実体はこのPCの保存先フォルダにあり、ブラウザには保存しません。定期点検の「保存データを消去」では消えません。共有の端末では、使い終わったら「一覧を消去」を押してください。",
  },
});

export const SENKETSU: DocKind = defineKind({
  id: "senketsu",
  apiKind: "senketsu",
  label: "専決決裁書",
  route: "/senketsu",
  menuLabel: "専決決裁書",
  pageTitle: "Folio — 専決決裁書",
  pageDescription:
    "専決決裁書PDFの取得 (このPCのローカルサーバー経由) と取得済み一覧の確認",
  filePrefix: "専決決裁書No.",
  // 専決決裁書には監督・営業が無いので、お客様の情報への反映欄は出さない
  showStaffSync: false,
  flagColumns: [
    { key: "cloud_stored", head: "クラウド", label: "クラウド格納済み", todo: "未格納", done: "格納済み" },
  ],
  listFilters: [
    { value: "all", label: "すべて", flagKey: null },
    { value: "cloud", label: "クラウド未格納", flagKey: "cloud_stored" },
  ],
  dataColumns: [
    { head: "表題", field: "title" },
    { head: "物件名", field: "property_name" },
    { head: "申請日", field: "shinsei_date" },
    { head: "申請者", field: "shinseisha" },
    { head: "決裁申請額(税込)", field: "amount", align: "right" },
    { head: "支払先", field: "payee" },
    { head: "最終承認日", field: "final_approved_at" },
  ],
  text: {
    sensitiveFields: "表題・物件名・申請者・支払先・決裁申請額",
    flagMarks: "格納済みの印",
    completedHint: "クラウド格納済みにチェックが付いた行のことです",
    storageDescription:
      "専決決裁書の取得済み一覧には、伝票No.・表題・物件名 (施主名を含むことがあります)・申請者・支払先・決裁申請額・格納済みの印が入ります。これらはローカルサーバーのトークン・1回に取る件数とあわせて、このブラウザ内にだけ保存され、folio のサーバーには送信されません。印の正本はPCの記録で、この一覧はその写しです (消しても再接続すれば戻ります)。PDFの実体はこのPCの保存先フォルダにあり、ブラウザには保存しません。定期点検の「保存データを消去」では消えません。共有の端末では、使い終わったら「一覧を消去」を押してください。",
  },
});

export const DOC_KINDS: readonly DocKind[] = [TENMATSU, SENKETSU];
export const DOC_KIND_BY_ID: Record<DocKindId, DocKind> = {
  tenmatsu: TENMATSU,
  senketsu: SENKETSU,
};

/** 「一覧を消去」の確認文 */
export function clearListConfirmText(kind: DocKind): string {
  const marks = kind.flagColumns.map((c) => c.label).join("・");
  return (
    `この画面に保存している取得済み一覧 (${kind.text.sensitiveFields}を含みます) を` +
    "このブラウザから消去します。" +
    `PCに保存されたPDFと、${marks}の印は消えません。` +
    "再接続すれば元に戻ります。よろしいですか？"
  );
}

/** 「一覧を消去」のあとに出す案内 */
export function clearedNoticeText(kind: DocKind): string {
  return (
    "この画面に保存していた分を消しました。" +
    "「一覧を再読み込み」または「つなぎ直す」で元に戻ります" +
    ` (PDFと${kind.text.flagMarks}はPCに残っています)`
  );
}

/**
 * 印を変えられなかったときの文言。
 * definite=false は「書けたのに失敗に見える」ことがある場合で、
 * ここで「保存されていません」と言うと手作業をやり直させてしまう。
 */
export function flagErrorText(
  kind: DocKind,
  no: string,
  definite: boolean,
  reason: string,
): string {
  return definite
    ? `伝票No. ${no} の${kind.text.flagMarks}を変更できませんでした (${reason})`
    : `伝票No. ${no} の${kind.text.flagMarks}を保存できたか確認できませんでした (${reason})。` +
        "「一覧を再読み込み」で確かめてください";
}

/** PC側のツールがこの種類に対応しているか（顛末書は常に対応） */
export function supportsKind(kind: DocKind, health: HealthPayload | null): boolean {
  if (kind.apiKind === null) return true;
  if (!health) return true; // まだ繋いでいない。判定しない
  return (health.kinds ?? []).some((k) => k.kind === kind.apiKind);
}

/** /health が返した種類の情報（表示名を引くのに使う） */
export function findHealthKind(health: HealthPayload | null, id: string) {
  return (health?.kinds ?? []).find((k) => k.kind === id) ?? null;
}

/** PC側が未対応のときの案内 */
export function unsupportedServerText(kind: DocKind): string {
  return (
    `このPCの顛末書取得ツールは${kind.label}に未対応です。` +
    "~/tenmatsu-dl/ を新しいものに入れ替えて、サーバーを起動し直してください。"
  );
}
