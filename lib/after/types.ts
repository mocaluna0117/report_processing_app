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
  /** 123-4567 (半角・ハイフン付き)。読めない・無いときは空文字 */
  postalCode: string;
  address: string;
  contacts: Contact[];
  emails: string[];
  /** yyyy/mm/dd (ゼロ埋め)。無ければ null */
  handoverDate: string | null;
  /** 監督。顛末書の「どこで」から反映する (取り込み元には無い項目) */
  supervisor: string;
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
  /**
   * 点検保守台帳が空欄だったので助っ人クラウドから補った値 (取り込み値より優先、修正より下)。
   * 台帳側に値が入ったら外れる。古い保存データには無いので任意。
   */
  supplements?: Partial<CustomerFields>;
  /** 利用者の修正 (再取込でも残す) */
  edits: Partial<CustomerFields>;
  issues: CustomerIssue[];
  corporate: boolean;
  /** 検索用に正規化した文字列 */
  searchKey: string;
  importedAt: number;
  editedAt: number | null;
  /**
   * 定期点検の写真報告書から引渡日を反映した記録 (画面に出どころを出すため)。
   * edits.handoverDate と同じ値のときだけ有効とみなす。
   * 手で別の値に直した・取り込んだ内容に戻した・再取込で同じ値になった、
   * いずれの場合も自然に無効になるので消す処理は要らない。
   */
  reportSync?: ReportSync;
  /**
   * 顛末書から監督・営業を反映した記録 (画面に出どころを出すため)。
   * edits の値と同じときだけ有効とみなすので、手で直せば自然に外れる。
   * 古い保存データには無いので任意。
   */
  tenmatsuSync?: TenmatsuSync;
}

/** 顛末書から監督・営業を反映した記録 (個人情報は持たない) */
export interface TenmatsuSync {
  supervisor?: string;
  salesRep?: string;
  /** 反映した日時 */
  at: number;
  /** 元になった顛末書のPJ (表示用) */
  pj: string | null;
}

/** 写真報告書から引渡日を反映した記録 (個人情報は持たない) */
export interface ReportSync {
  handoverDate: string;
  /** 反映した日時 */
  at: number;
  /** 元になった報告書のPJ (表示用) */
  pj: string | null;
}

/** 受付一覧の1件。ResultRow 互換にして結果テーブル・メール文・完了報告書をそのまま使う */
export type AfterCase = ResultRow & {
  kind: "after";
  customerId: string;
  customerSource: CustomerSource;
  /** 貼り付けた受付メモ (ブラウザ内のみ) */
  inquiryText: string;
  /** 要約APIへ送った伏せ字済みの受付メモ (学習用)。古い保存データには無い */
  redactedInquiry?: string;
  /** 登録した時点の要約 (手直し前)。学習ボタンで「手直し済みか」を出すのに使う */
  originalSummary?: string;
  createdAt: number;
};
