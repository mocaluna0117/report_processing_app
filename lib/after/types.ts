// アフターメンテナンスの顧客データと受付の型。
// 顧客情報はこの端末のブラウザ内 (IndexedDB) にだけ置き、サーバーへは送らない。
import type { ResultRow } from "@/lib/process";
import type { Contact } from "@/lib/types";

/** suketto: 助っ人クラウド (旧システム・取込は一度きり) / dx: 点検保守台帳 (今後の正) */
export type CustomerSource = "suketto" | "dx";

/** 取り込み・編集の対象になる項目 (この単位で利用者の修正を上書きする) */
export interface CustomerFields {
  /** 10桁のPJ (契約番号)。変換できなければ null */
  pj: string | null;
  developer: string | null;
  propertyName: string;
  /** 姓　名 (全角スペース区切り)。法人名はそのまま */
  ownerName: string;
  /** カタカナ・全角スペース区切り */
  ownerKana: string;
  address: string;
  contacts: Contact[];
  emails: string[];
  /** yyyy/mm/dd (ゼロ埋め)。無ければ null */
  handoverDate: string | null;
  salesRep: string;
  memo: string;
}

/** 取り込み時に判断できなかったこと (画面で直してもらう) */
export interface CustomerIssue {
  /** 対応する項目。利用者がその項目を編集したら解消とみなす */
  field: keyof CustomerFields | null;
  message: string;
}

export interface Customer {
  /** dx:<PJ> / sk:<取込内容のハッシュ> */
  id: string;
  source: CustomerSource;
  /** 元の管理ID・物件番号 (取り込み元をたどるため) */
  sourceKey: string;
  /** 元ファイルの行番号 (1始まり)。スキップ報告と突き合わせる */
  sourceRow: number;
  /** 取り込んだ値 (再取込で置き換わる) */
  imported: CustomerFields;
  /** 利用者の修正 (再取込でも残す) */
  edits: Partial<CustomerFields>;
  issues: CustomerIssue[];
  corporate: boolean;
  /** 検索用に正規化した文字列 */
  searchKey: string;
  importedAt: number;
  editedAt: number | null;
}

/** 受付一覧の1件。ResultRow 互換にして結果テーブル・メール文・完了報告書をそのまま使う */
export type AfterCase = ResultRow & {
  kind: "after";
  customerId: string;
  customerSource: CustomerSource;
  /** 貼り付けた受付メモ (ブラウザ内のみ) */
  inquiryText: string;
  createdAt: number;
};
