import { DEFAULT_COMPOSE, type ComposeRules } from "./parse/natsuin";
import { type KindId, type RouteId, type RouteScope, isKindId } from "./protocol";

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
 * ★一覧への行き方は**経路 (routes)** として持つ。アカウントの権限で使える画面が違い、
 *   「閲覧」タブ (自部門検索) が無い人は「ワークフロー」タブ (申請検索) から取るため。
 *   先頭から順に試し、開けた経路で一覧の行と伝票画面を読む (lib/rakuraku/navigation.ts の gotoList)。
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
  /** 最後の手段。★これに頼らない（ページごとに描き直されるため） */
  nextPageJs: string;
  nextPageWaitMs: number;
  maxPages: number;
}

/** 画面とログに出す経路の名前。ブラウザ側の選択肢にも使う */
export const ROUTE_LABELS: Readonly<Record<RouteId, string>> = {
  jibumon: "閲覧（自部門検索）",
  shinsei: "ワークフロー（申請検索）",
};

/** 一覧への行き方 (経路)。1つの種類がいくつか持ち、先頭から順に試す */
export interface ListRoute {
  id: RouteId;
  label: string;
  /** 一覧に出る伝票の範囲。own（自分が申請した伝票だけ）は画面で必ず伝える */
  scope: RouteScope;
  /** 一覧のパス（テナントの場所からの相対）。空ならメニューをたどる */
  listPath: string;
  /** ★一覧に着いたかの目印。この経路の伝票画面の URL に含まれない文字にすること */
  listUrlMarker: string;
  menuText: string;
  menuSteps?: readonly MenuStep[];
  menuStepWaitMs: number;
  /** ★この経路で開く伝票画面の URL に含まれる文字（経路で伝票画面が変わる） */
  detailUrlMarker: string;
  /** 一覧の列の見出しがこの経路だけ違うときの上書き */
  list?: Partial<Pick<ListSettings, "colDenpyoNo" | "colStatus" | "columns" | "approvedValues">>;
  /** 実画面で未確認（「画面の下見」の結果で値を直す）。ログにその旨を出す */
  unverified?: boolean;
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
  /** 一覧への経路。★先頭から順に試す（閲覧 → ワークフロー） */
  routes: readonly ListRoute[];
  list: ListSettings;
  detail: DetailSettings;
  keepParts: boolean;
  compose?: ComposeSettings;
}

/** 経路を1つに決めた種類。一覧の行・伝票画面を読む関数はこれを受け取る */
export interface ResolvedKind extends RakurakuKind {
  route: ListRoute;
}

/** 経路を1つに決める（経路ごとの列の上書きをここで重ねる） */
export function resolveKind(kind: RakurakuKind, route: ListRoute): ResolvedKind {
  return { ...kind, route, list: route.list ? { ...kind.list, ...route.list } : kind.list };
}

/**
 * ログインしたアカウントに合わせて、経路を試す順に並べる。
 *
 * ★「閲覧」タブが無いアカウント（viewTab === false）は自部門検索を使えないので、申請検索を先に試す。
 *   **消さずに後ろへ回す**ので、判定が外れていても開ける経路があればそこへ切り替わる。
 * ★分からない（undefined / null＝古い札や古いサーバー）ときは、今までどおり種類の並び。
 * ★この規則は gotoList（lib/rakuraku/navigation.ts）と画面の両方が使う。
 *   画面は「どの経路で取るか」を先に伝えるために読むので、言うことがずれないよう1か所に置く。
 */
export function routesForAccount(kind: RakurakuKind, viewTab: boolean | null | undefined): ListRoute[] {
  if (viewTab !== false) return [...kind.routes];
  return [
    ...kind.routes.filter((r) => r.scope !== "department"),
    ...kind.routes.filter((r) => r.scope === "department"),
  ];
}

/** その種類にその経路があれば返す。無ければ null */
export function findRoute(kind: RakurakuKind, id: RouteId | null | undefined): ListRoute | null {
  if (!id) return null;
  return kind.routes.find((r) => r.id === id) ?? null;
}

/**
 * 伝票画面に着いたかを見る目印。
 * ★一覧から読んだ URL がどれか1つの経路の目印を含むなら、それを使う
 *   （経路の推測が外れていても、URL が分かっている伝票は開ける）。
 */
export function detailMarkerFor(kind: ResolvedKind, href: string | null): string {
  if (href) {
    const hit = kind.routes.filter((r) => r.detailUrlMarker !== "" && href.includes(r.detailUrlMarker));
    if (hit.length === 1) return hit[0].detailUrlMarker;
  }
  return kind.route.detailUrlMarker;
}

/** 一覧の設定のうち、3種類で共通のもの */
const LIST_BASE = {
  tableSelector: "table#listTable",
  colDenpyoNo: "伝票No.",
  colStatus: "状態",
  approvedValues: ["承認済"],
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
    filePrefix: "顛末書№",
    routes: [
      {
        id: "jibumon",
        label: ROUTE_LABELS.jibumon,
        scope: "department",
        listPath: "sapWorkflowJibumonKensaku/initializeView?workflowId=4&refId=4",
        listUrlMarker: "sapWorkflowJibumonKensaku",
        menuText: "顛末書",
        menuStepWaitMs: 5_000,
        detailUrlMarker: "workflowDetailView",
      },
      {
        // ★「閲覧」タブが無いアカウント向け。2026-09-19 の「画面の下見」で実画面を確認済み
        //   （一覧の列の見出し・伝票画面の部品は閲覧側と同じ。伝票画面のパスだけが違う）
        id: "shinsei",
        label: ROUTE_LABELS.shinsei,
        scope: "own",
        listPath: "sapWorkflowShinseiKensaku/initializeView?workflowId=4&refId=4",
        listUrlMarker: "sapWorkflowShinseiKensaku",
        menuText: "顛末書",
        menuSteps: [{ text: "ワークフロー" }, { text: "行為の申請(稟議)" }, { text: "一覧", near: "顛末書" }],
        menuStepWaitMs: 5_000,
        detailUrlMarker: "sapWorkflowDenpyo/detailView",
      },
    ],
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
    filePrefix: "専決決裁書№",
    routes: [
      {
        id: "jibumon",
        label: ROUTE_LABELS.jibumon,
        scope: "department",
        listPath: "sapWorkflowJibumonKensaku/initializeView?workflowId=3&refId=3",
        listUrlMarker: "sapWorkflowJibumonKensaku",
        menuText: "専決決裁書",
        menuStepWaitMs: 5_000,
        detailUrlMarker: "workflowDetailView",
      },
      {
        // ★「閲覧」タブが無いアカウント向け。2026-09-19 の「画面の下見」で実画面を確認済み
        id: "shinsei",
        label: ROUTE_LABELS.shinsei,
        scope: "own",
        listPath: "sapWorkflowShinseiKensaku/initializeView?workflowId=3&refId=3",
        listUrlMarker: "sapWorkflowShinseiKensaku",
        menuText: "専決決裁書",
        menuSteps: [{ text: "ワークフロー" }, { text: "行為の申請(稟議)" }, { text: "一覧", near: "専決決裁書" }],
        menuStepWaitMs: 5_000,
        detailUrlMarker: "sapWorkflowDenpyo/detailView",
      },
    ],
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
    filePrefix: "捺印決裁書№",
    // ★捺印決裁書はもともと「ワークフロー」側だけ。一覧も伝票画面もパスが別
    routes: [
      {
        id: "shinsei",
        label: ROUTE_LABELS.shinsei,
        scope: "own",
        listPath: "sapWorkflowShinseiKensaku/initializeView?workflowId=8&refId=8",
        listUrlMarker: "sapWorkflowShinseiKensaku",
        menuText: "捺印決裁書",
        menuSteps: [{ text: "ワークフロー" }, { text: "押印の申請" }, { text: "一覧", near: "捺印決裁書" }],
        menuStepWaitMs: 5_000,
        detailUrlMarker: "sapWorkflowDenpyo/detailView",
      },
    ],
    list: {
      ...LIST_BASE,
      columns: { shinsei_date: "申請日", shinseisha: "申請者", content: "内容", senketsu_no: "専決決裁書№" },
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
