import { DEFAULT_COMPOSE, type ComposeRules } from "./parse/natsuin";
import { type KindId, isKindId } from "./protocol";

export { type KindId, isKindId } from "./protocol";

/**
 * 書類の種類ごとの、楽楽精算の画面の設定。
 *
 * 移植元: tenmatsu-dl/config.json（`list` / `detail` / `kinds.*`）と tenmatsu.py `kind_config` 174-216。
 *
 * ★**種類ごとに完全な形で書き下す。実行時に設定同士を混ぜ合わせない。**
 *   移植元はトップレベルの設定（顛末書用）に種類の設定を重ねて平らにしていたが、
 *   平らにしたもの同士を混ぜると、列の指定や捺印決裁書の合成の設定が**別の種類へ漏れる**
 *   不具合があった（tenmatsu.py:219-223）。ここでは種類ごとの値がそのまま見える形にする。
 * ★テナントの URL は書かない。一覧のパスは**相対**で持ち、`resolveTenantPath` で組む。
 * ★ブラウザ側（記録に残す項目の決定）からも読むので、Playwright にも server-only にも依存しない。
 *   秘密の値は置かないこと。
 */

export interface MenuStep {
  text: string;
  /** 同じ文字の候補が複数あるとき、この文字を含む先祖が近いものを選ぶ */
  near?: string;
}

export interface ListSettings {
  tableSelector: string;
  /** 伝票No.の列の見出し */
  colDenpyoNo: string;
  /** 状態の列の見出し */
  colStatus: string;
  /** 一覧から読む追加の列（記録のキー → 見出し） */
  columns: Readonly<Record<string, string>>;
  /** ★部分一致で判定する。実画面は「承認済み」 */
  approvedValues: readonly string[];
  /** ★伝票画面の URL に含まれる文字。一覧の目印とは必ず別の文字にする */
  detailUrlMarker: string;
  /** 最後の手段。★これに頼らない（ページごとに描き直されるため） */
  nextPageJs: string;
  nextPageWaitMs: number;
  maxPages: number;
}

export interface DetailSettings {
  tableSelector: string;
  detailWaitMs: number;
  /** 伝票画面から読む項目（記録のキー → ラベル） */
  labels: Readonly<Record<string, string>>;
  /** 物件名を取り出すときのラベル（「〇〇：値」の〇〇） */
  propertyNameLabel?: string;
  /** 物件名を取り出す元の項目 */
  propertyNameSource?: "content" | "remarks";
  readApprovalLog: boolean;
  approvalLogSelector: string;
  approvalLogText: string;
  approvalLogClickTimeoutMs: number;
  approvalLogWaitMs: number;
  approvalLogDateColumns: readonly string[];
  approvalLogExcludeWords: readonly string[];
  approvalLogKeywords: readonly string[];
  approvalLogTextFallback: boolean;
  printButtonSelector: string;
  printButtonText: string;
  printButtonWaitMs: number;
  printClickWaitMs: number;
  printPopupWaitMs: number;
  attachmentSelector: string;
}

export interface ComposeSettings {
  linkedKind: KindId;
  /** 紐づく伝票No.を読む項目 */
  linkKey: string;
  maxLinkPages: number;
  uploadName: string;
  rules: ComposeRules;
  /** 紐づく伝票の画面から写す項目（捺印決裁書の画面に無いもの） */
  copyFromLinked: readonly string[];
}

export interface RakurakuKind {
  id: KindId;
  label: string;
  filePrefix: string;
  /** 一覧のパス（テナントの場所からの相対） */
  listPath: string;
  /** ★一覧に着いたかの目印。伝票画面の URL に含まれない文字にすること */
  listUrlMarker: string;
  menuText: string;
  menuSteps?: readonly MenuStep[];
  menuStepWaitMs: number;
  list: ListSettings;
  detail: DetailSettings;
  keepParts: boolean;
  compose?: ComposeSettings;
}

/** 一覧の設定のうち、3種類で共通のもの */
const LIST_BASE = {
  tableSelector: "table#listTable",
  colDenpyoNo: "伝票No.",
  colStatus: "状態",
  approvedValues: ["承認済"],
  detailUrlMarker: "workflowDetailView",
  nextPageJs: "() => DenpyoKensaku.pageFeed(1)",
  nextPageWaitMs: 15_000,
  maxPages: 20,
} as const;

/** 伝票画面の設定のうち、3種類で共通のもの */
const DETAIL_BASE = {
  tableSelector: "table.d_table_contents",
  detailWaitMs: 8_000,
  readApprovalLog: true,
  approvalLogSelector: "[onclick*='shoninLogKensaku']",
  approvalLogText: "承認履歴",
  approvalLogClickTimeoutMs: 5_000,
  approvalLogWaitMs: 6_000,
  approvalLogDateColumns: ["日付", "承認日", "処理日", "日時"],
  approvalLogExcludeWords: ["差戻", "取下", "却下", "否認"],
  approvalLogKeywords: ["承認"],
  approvalLogTextFallback: true,
  printButtonSelector: "button.accesskeyPrint",
  printButtonText: "印刷",
  printButtonWaitMs: 10_000,
  printClickWaitMs: 10_000,
  printPopupWaitMs: 15_000,
  attachmentSelector: 'span[onclick*="downloadFileData"]',
} as const;

export const KINDS: Readonly<Record<KindId, RakurakuKind>> = {
  tenmatsu: {
    id: "tenmatsu",
    label: "顛末書",
    filePrefix: "顛末書No.",
    listPath: "sapWorkflowJibumonKensaku/initializeView?workflowId=4&refId=4",
    listUrlMarker: "sapWorkflowJibumonKensaku",
    menuText: "顛末書",
    menuStepWaitMs: 5_000,
    list: {
      ...LIST_BASE,
      columns: {
        shinsei_date: "申請日",
        shinseisha: "申請者",
        amount: "支払金額(税込)",
        payee: "支払先",
        where: "どこで",
      },
    },
    detail: {
      ...DETAIL_BASE,
      // ★pj はラベルで取れなければ「どこで」のすぐ下の行から探す（parse/tables.ts pickPjNearLabel）
      labels: { shinsei_date: "申請日", where: "どこで", pj: "PJコード" },
    },
    keepParts: false,
  },

  senketsu: {
    id: "senketsu",
    label: "専決決裁書",
    filePrefix: "専決決裁書No.",
    listPath: "sapWorkflowJibumonKensaku/initializeView?workflowId=3&refId=3",
    listUrlMarker: "sapWorkflowJibumonKensaku",
    menuText: "専決決裁書",
    menuStepWaitMs: 5_000,
    list: {
      ...LIST_BASE,
      columns: { shinsei_date: "申請日", shinseisha: "申請者" },
    },
    detail: {
      ...DETAIL_BASE,
      // 表題・支払先・金額・内容は一覧ではなく伝票画面から読む
      labels: {
        shinsei_date: "申請日",
        title: "表題",
        payee: "支払先",
        amount: "決裁申請額(税込)",
        content: "内容",
      },
      propertyNameLabel: "物件名",
      propertyNameSource: "content",
    },
    keepParts: false,
  },

  natsuin: {
    id: "natsuin",
    label: "捺印決裁書",
    filePrefix: "捺印決裁書No.",
    // ★捺印決裁書は一覧も伝票画面もパスが別
    listPath: "sapWorkflowShinseiKensaku/initializeView?workflowId=8&refId=8",
    listUrlMarker: "sapWorkflowShinseiKensaku",
    menuText: "捺印決裁書",
    menuSteps: [{ text: "ワークフロー" }, { text: "押印の申請" }, { text: "一覧", near: "捺印決裁書" }],
    menuStepWaitMs: 5_000,
    list: {
      ...LIST_BASE,
      columns: { shinsei_date: "申請日", shinseisha: "申請者", content: "内容", senketsu_no: "専決決裁書№" },
      detailUrlMarker: "sapWorkflowDenpyo/detailView",
    },
    detail: {
      ...DETAIL_BASE,
      // 支払先・決裁申請額は捺印決裁書の画面に無いので、紐づく専決決裁書から写す
      labels: { shinsei_date: "申請日", content: "内容", senketsu_no: "専決決裁書№", remarks: "備考" },
      propertyNameLabel: "物件名",
      propertyNameSource: "remarks",
    },
    keepParts: true,
    compose: {
      linkedKind: "senketsu",
      linkKey: "senketsu_no",
      maxLinkPages: 20,
      uploadName: "あとからアップロードする書類",
      rules: DEFAULT_COMPOSE,
      copyFromLinked: ["payee", "amount"],
    },
  },
};

/** 種類の設定。★知らない種類は受け付けない（黙って顛末書に落とさない） */
export function getKind(id: string): RakurakuKind {
  if (!isKindId(id)) throw new Error(`知らない種類です: ${id}`);
  return KINDS[id];
}
