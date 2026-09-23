/**
 * 「使い方」ページに載せる写真の台本。どの画面を、どんな状態で、どこを切り取って撮るか。
 *
 * ★印の位置はここにセレクターで書く。スクリプトが実測して lib/help-shots.generated.ts に書き出すので、
 *   画面を直して撮り直せば印もついてくる（手で測った座標が静かに腐るのを防ぐ）。
 * ★印の**文言**は lib/help-shots.ts にある。数と並びをここと合わせること（テストが見張る）。
 * ★ボタンは押さない（Gemini を呼ぶ操作をしない）。状態はすべてデータで作る。
 */
import type { Page } from "playwright-core";
import { COLUMNS } from "@/lib/tsv";
import { DENPYO_NOS, HANAKO, SHOT_DATE, TARO, cellsOf, inspectionFileName } from "./fixtures";
import type { SeedData } from "./seed";

export interface Hotspot {
  /** 印を置く要素 */
  at: string;
  /** その要素の中のどこを指すか（既定は中央） */
  dx?: number;
  dy?: number;
}

export interface Recipe {
  /** lib/help-shots.ts の HelpShot.id と同じ */
  id: string;
  path: string;
  seed?: SeedData;
  /** 楽楽精算にログイン済みに見せる（部門も入れておくと読みに行かない） */
  login?: { departments?: { code: string; label: string }[]; deptCode?: string; kind?: string };
  /**
   * 楽楽精算のログインの画面（モーダル）を自動で出さない。
   * ★未ログインのまま顛末書系の画面を撮るときに要る（出したままだと写真を覆う）。
   */
  dismissLogin?: boolean;
  /** 撮る前の操作（押しても外へ出ない操作だけ） */
  act?: (page: Page) => Promise<void>;
  /** 撮る前に隠す要素（「使い方」ページに同じ文章が載っている部分など） */
  hide?: string[];
  /** 切り取る範囲（この要素すべてを囲む） */
  clip: string[];
  /** 切り取りの余白（CSSピクセル） */
  pad?: number;
  hotspots: Hotspot[];
}

// ---------------------------------------------------------------------------
// 架空のデータ
// ---------------------------------------------------------------------------

const photoId = (who: typeof TARO | typeof HANAKO) => `f-${who.pj}-photo`;
const inspectionId = (who: typeof TARO | typeof HANAKO) => `f-${who.pj}-inspection`;

const files = (): SeedData["files"] =>
  [TARO, HANAKO].flatMap((who) => [
    { id: photoId(who), name: inspectionFileName(who, "写真報告書") },
    { id: inspectionId(who), name: inspectionFileName(who, "点検報告書") },
  ]);

const pairs = () => [
  {
    id: `p-${TARO.pj}`,
    photoId: photoId(TARO),
    inspectionId: inspectionId(TARO),
    date: "20260722",
    ownerDisplay: TARO.name,
    needsReview: false,
  },
  {
    id: `p-${HANAKO.pj}`,
    photoId: photoId(HANAKO),
    inspectionId: inspectionId(HANAKO),
    date: "20260722",
    ownerDisplay: HANAKO.name,
    needsReview: false,
  },
];

/** 「黄色は要確認」を写真で見せるため、1つだけ確度を落とす列 */
const WARN_COLUMN = "受付種別";

const resultRow = (who: typeof TARO | typeof HANAKO, summary: string, warn = false) => ({
  pairId: `p-${who.pj}`,
  ownerDisplay: who.name,
  cells: cellsOf({
    物件数: "★",
    PJ: who.pj,
    受付種別: "2年点検",
    受付日: "2026/07/22",
    受付者: "受付担当",
    事業者: "タカマツハウス",
    物件名称: who.property,
    お客様氏名: who.name,
    住所: who.address,
    引渡日: who.handover,
    工事区分: "外装",
    アフター受付内容: summary,
    最終更新日: SHOT_DATE,
    備考欄: "9/1　点検報告書作成",
  }),
  confidences: cellsOf({}).map((_, i) => (warn && i === COLUMNS.indexOf(WARN_COLUMN) ? "warn" : "ok")),
  categories: [{ name: "外装", summary }],
  warnings: [],
  propertyCountMarked: true,
});

const customer = (who: typeof TARO | typeof HANAKO) => ({
  id: who.id,
  source: "dx",
  sourceKey: who.id,
  sourceRow: 2,
  imported: {
    pj: who.pj,
    developer: "タカマツハウス",
    propertyName: who.property,
    ownerName: who.name,
    ownerKana: who.kana,
    postalCode: "",
    address: who.address,
    contacts: [{ phone: who.phone, relation: "", confidence: "ok" }],
    emails: [],
    handoverDate: who.handover,
    supervisor: "",
    salesRep: "",
    memo: "",
  },
  edits: {},
  issues: [],
  corporate: false,
  searchKey: `${who.name} ${who.kana} ${who.pj} ${who.property} ${who.address} ${who.phone}`,
  importedAt: 1_756_684_800_000,
  editedAt: null,
});

const afterCase = (who: typeof TARO | typeof HANAKO, summary: string) => ({
  ...resultRow(who, summary),
  kind: "after",
  customerId: who.id,
  customerSource: "dx",
  inquiryText: `${who.name}様より、${summary}とのご連絡。`,
  createdAt: 1_756_684_800_000,
  cells: cellsOf({
    物件数: "★",
    PJ: who.pj,
    受付種別: "",
    受付日: SHOT_DATE,
    受付者: "受付担当",
    事業者: "タカマツハウス",
    物件名称: who.property,
    お客様氏名: who.name,
    住所: who.address,
    引渡日: who.handover,
    アフター受付内容: summary,
    最終更新日: SHOT_DATE,
  }),
});

/** 顛末書系の一覧（tests/tenmatsu-list-view.test.ts と同じ番号） */
const listItems = (prefix: "TE" | "SE" | "NK", label: string) => {
  const no = (i: number) => `${prefix}0000${DENPYO_NOS[i]}`;
  const base = (i: number) => ({
    denpyo_no: no(i),
    file: `${label}№${DENPYO_NOS[i]}.pdf`,
    at: "2026-09-01T10:00:00",
    exists: true,
    pages: 3,
    size: 29_140,
    shinsei_date: "2026/08/28",
    shinseisha: HANAKO.name,
    amount: "71,500 円",
    payee: "架空工務店",
    property_name: TARO.property,
    budget_entered: false,
    cloud_stored: false,
    completed: false,
    flags_updated_at: null,
  });
  return { no, base };
};

const tenmatsuList = () => {
  const { base } = listItems("TE", "顛末書");
  return [
    { ...base(5), exists: false, pages: null, size: null },
    { ...base(4), pending: true, missing_attachments: [{ index: 0, name: "見積書.xlsx", reason: "PDFにできない形式です" }] },
    { ...base(3), budget_entered: true, cloud_stored: true, completed: true },
    { ...base(2), cloud_stored: true },
    { ...base(1), budget_entered: true },
    { ...base(0) },
  ];
};

const senketsuList = () => {
  const { base } = listItems("SE", "専決決裁書");
  return [
    { ...base(3), title: "外壁補修工事の発注", cloud_stored: true, completed: true },
    { ...base(2), title: "屋根点検の外注" },
    { ...base(1), title: "給湯器の交換" },
    { ...base(0), title: "植栽の手入れ" },
  ];
};

const natsuinList = () => {
  const { base } = listItems("NK", "捺印決裁書");
  const awaiting = { index: 0, name: "御見積書", reason: "アップロード待ち", awaiting: true };
  return [
    { ...base(2), content: "工事請負契約書", pending: true, missing_attachments: [awaiting] },
    { ...base(1), content: "覚書", pending: true, missing_attachments: [awaiting] },
    {
      ...base(0),
      content: "業務委託契約書",
      senketsu_no: "SE00009001",
      // ★完了にすると既定の絞り込みで隠れてしまう（「差し替え」を見せたいので未格納のまま）
      cloud_stored: false,
      completed: false,
      // 確定済み。部品が残っているので「差し替え」が出る
      upload_slots: [
        { index: 0, name: "御見積書", files: [{ file: "_部品/NK00009001_御見積書.pdf", name: "御見積書.pdf", size: 18_400, pages: 2 }] },
      ],
      recomposed_at: "2026-09-01T11:00:00",
    },
  ];
};

const LOGIN_DEPARTMENTS = [
  { code: "1800", label: "アフターメンテナンス課(1800)" },
  { code: "1900", label: "架空営業所(1900)" },
];

// ---------------------------------------------------------------------------
// 台本（12枚）
// ---------------------------------------------------------------------------

export const RECIPES: readonly Recipe[] = [
  // --- 定期点検 ---
  {
    id: "inspection-drop",
    path: "/",
    hide: ['nav[aria-label="定期点検の手順"] > div:last-child'],
    clip: ['nav[aria-label="定期点検の手順"]', "#inspection-drop"],
    hotspots: [
      { at: 'nav[aria-label="定期点検の手順"] li:first-child span[aria-hidden]' },
      { at: "#inspection-drop button p:first-of-type", dy: 0.1 },
      { at: "#inspection-drop button p:last-of-type" },
    ],
  },
  {
    id: "inspection-pairs",
    path: "/",
    seed: { files: files(), meta: { pairs: pairs() } },
    clip: ["#inspection-pairs"],
    hotspots: [
      { at: "#inspection-pairs table tbody tr:first-child td:first-child" },
      { at: "#inspection-pairs table tbody tr:first-child select", dx: 0.8 },
      { at: '#inspection-pairs button:has-text("処理")' },
    ],
  },
  {
    id: "inspection-results",
    path: "/",
    seed: {
      files: files(),
      meta: {
        pairs: pairs(),
        results: [
          resultRow(TARO, "浴室の換気扇から異音がするとのこと。", true),
          resultRow(HANAKO, "2階洋室の窓が閉まりにくいとのこと。"),
        ],
      },
    },
    clip: ["#inspection-results"],
    hotspots: [
      { at: '#inspection-results button:has-text("Excel用にコピー")' },
      // 黄色（要確認）のセルを指す。列は 施主/物件数/PJ/受付種別 の順
      { at: "#inspection-results table tbody tr:first-child td:nth-child(4)" },
      { at: '#inspection-results button:has-text("メール文")' },
    ],
  },
  // --- アフターメンテナンス ---
  {
    id: "after-import",
    path: "/after",
    hide: ['nav[aria-label="アフターメンテナンス受付の手順"] > div:last-child'],
    clip: ['nav[aria-label="アフターメンテナンス受付の手順"]', "#after-import"],
    hotspots: [
      { at: "#after-import button[type=button] p:first-of-type", dy: 0.1 },
      { at: 'nav[aria-label="アフターメンテナンス受付の手順"] li:first-child span[aria-hidden]' },
    ],
  },
  {
    id: "after-intake",
    path: "/after",
    seed: { customers: [customer(TARO), customer(HANAKO)] },
    act: async (page) => {
      await page.fill("#customer-search", "やまだ");
      await page.click('#after-search button:has-text("山田")');
      await page.fill("#after-intake textarea", "浴室の換気扇から異音がする。2階洋室の窓が閉まりにくい。");
    },
    clip: ["#after-search", "#after-intake"],
    hotspots: [
      { at: "#customer-search" },
      { at: "#after-intake textarea", dy: 0.3 },
      { at: '#after-intake button:has-text("受付を登録")' },
    ],
  },
  {
    id: "after-cases",
    path: "/after",
    seed: {
      customers: [customer(TARO), customer(HANAKO)],
      meta: {
        afterCases: [
          afterCase(TARO, "浴室の換気扇から異音がする。"),
          afterCase(HANAKO, "2階洋室の窓が閉まりにくい。"),
        ],
      },
    },
    clip: ["#after-cases"],
    hotspots: [
      { at: "#after-cases table tbody tr:first-child td:nth-child(4)" },
      { at: '#after-cases button:has-text("Excel用にコピー")' },
      { at: '#after-cases button:has-text("完了報告書")' },
    ],
  },
  // --- 顛末書 ---
  {
    id: "tenmatsu-folder",
    path: "/tenmatsu",
    // ★未ログインで開くとログインの画面が出て写真を覆うので、出さない設定で撮る
    dismissLogin: true,
    hide: ['nav[aria-label="顛末書の手順"] > div:last-child'],
    // ★ログインの欄は画面から無くしたので、ヘッダーの表示まで入れて撮る
    clip: ["header", "#tenmatsu-folder"],
    hotspots: [
      { at: "#rakuraku-login" },
      { at: '#tenmatsu-folder button:has-text("共有フォルダーを選ぶ")' },
    ],
  },
  {
    id: "tenmatsu-login",
    path: "/tenmatsu",
    // ★未ログインで開くと自分から出る。その画面をそのまま撮る
    clip: ['[role="dialog"][aria-label="楽楽精算にログイン"]'],
    // ★余白を足すと後ろの画面の文字が切れて写る。小窓だけを切り取る
    pad: 0,
    hotspots: [
      { at: '[role="dialog"] input[type="text"]' },
      { at: '[role="dialog"] input[type="password"]' },
      { at: '[role="dialog"] button[type="submit"]' },
    ],
  },
  {
    id: "tenmatsu-list",
    path: "/tenmatsu",
    login: { departments: LOGIN_DEPARTMENTS, deptCode: "1800", kind: "tenmatsu" },
    seed: { meta: { "tenmatsu:folderList": tenmatsuList() } },
    clip: ["#tenmatsu-list"],
    hotspots: [
      { at: "#tenmatsu-list table tbody tr:nth-child(2)", dx: 0.2 },
      { at: "#tenmatsu-list table tbody tr:first-child", dx: 0.2 },
      { at: '#tenmatsu-list button[aria-label*="実行予算入力済み"]', dx: 0.5 },
    ],
  },
  // --- 専決決裁書 ---
  {
    id: "senketsu-run",
    path: "/senketsu",
    login: { departments: LOGIN_DEPARTMENTS, deptCode: "1800", kind: "senketsu" },
    clip: ["#senketsu-run"],
    hotspots: [
      { at: '#senketsu-run label:has-text("部門") select' },
      { at: "#senketsu-run input[type=number]" },
      { at: '#senketsu-run button:has-text("専決決裁書を取得")' },
    ],
  },
  {
    id: "senketsu-list",
    path: "/senketsu",
    login: { departments: LOGIN_DEPARTMENTS, deptCode: "1800", kind: "senketsu" },
    seed: { meta: { "senketsu:folderList": senketsuList() } },
    clip: ["#senketsu-list"],
    hotspots: [
      { at: "#senketsu-list select" },
      { at: '#senketsu-list button[aria-label*="クラウド格納済み"]' },
      { at: '#senketsu-list label:has-text("完了したものも表示")' },
    ],
  },
  // --- 捺印決裁書 ---
  {
    id: "natsuin-run",
    path: "/natsuin",
    login: { departments: LOGIN_DEPARTMENTS, deptCode: "1800", kind: "natsuin" },
    clip: ["#natsuin-run"],
    hotspots: [
      { at: '#natsuin-run button:has-text("捺印決裁書を取得")' },
      { at: "#natsuin-run p:has-text('アップロード待ち')" },
    ],
  },
  {
    id: "natsuin-list",
    path: "/natsuin",
    login: { departments: LOGIN_DEPARTMENTS, deptCode: "1800", kind: "natsuin" },
    seed: { meta: { "natsuin:folderList": natsuinList() } },
    clip: ["#natsuin-list"],
    hotspots: [
      { at: "#natsuin-list table tbody tr:first-child", dx: 0.2 },
      { at: '#natsuin-list button[aria-label*="書類を足す"]' },
      { at: '#natsuin-list button:has-text("差し替え")' },
    ],
  },
];
