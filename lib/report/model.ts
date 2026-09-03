// 完了報告書 (xlsx / PDF) に載せる値の組み立て。純関数のみ (ブラウザ・Nodeどちらでも動く)
import { NO_DEFECT_TEXT, circledNumber, formatPhenomena } from "@/lib/summarize/format";
import { recordSummary, splitInstructionItems } from "@/lib/summary";
import { toFullWidthSpace } from "@/lib/text";
import {
  ADDRESS_COL,
  HANDOVER_COL,
  OWNER_COL,
  PJ_COL,
  PROPERTY_COL,
  RECEPTION_DATE_COL,
  RECEPTION_TYPE_COL,
} from "@/lib/tsv";
import type { Contact } from "@/lib/types";

/** 定期点検か、アフターメンテナンスか (既定のチェック・別紙タイトルが変わる) */
export type ReportKind = "inspection" | "after";

/** 受付者は運用上固定 (見本の完了報告書と同じ) */
export const RECEPTIONIST = "木村美恵子";
/** ダウンロード時のファイル名 (行の内容に依らず固定) */
export const REPORT_XLSX_NAME = "完了報告書（原紙）.xlsx";
export const REPORT_PDF_NAME = "完了報告書（原紙）.pdf";

/** 本紙の指示内容の枠数。これを超えたら別紙に回す */
export const MAIN_SLOTS = 5;
/** 別紙に回す件数のしきい値 (6件以上) */
export const APPENDIX_THRESHOLD = MAIN_SLOTS + 1;
/** 別紙シートの項目枠数 (xlsx側の行数。PDFはページを増やせる) */
export const APPENDIX_SLOTS = 12;
/** 本紙の指示内容に「別紙参照」と書くときの文字列 */
export const APPENDIX_REFERENCE_TEXT = "別紙参照";

/** 立会・受付項目のチェック状態 (ダイアログで切り替える) */
export interface ReportOptions {
  attendance: { owner: boolean; family: boolean; other: boolean };
  categories: {
    inspection: boolean;
    after: boolean;
    paid: boolean;
    direct: boolean;
    free: boolean;
  };
}

/** 既定は「点検」のみチェック (見本の完了報告書と同じ) */
export const DEFAULT_REPORT_OPTIONS: ReportOptions = {
  attendance: { owner: false, family: false, other: false },
  categories: { inspection: true, after: false, paid: false, direct: false, free: false },
};

/** アフターメンテナンスの既定は「アフター」のみチェック */
export const AFTER_REPORT_OPTIONS: ReportOptions = {
  attendance: { owner: false, family: false, other: false },
  categories: { inspection: false, after: true, paid: false, direct: false, free: false },
};

/** アフターメンテナンスの別紙タイトル (点検時期を使わない) */
export const AFTER_APPENDIX_TITLE = "アフターメンテナンス是正項目";

/** 種別ごとの既定チェック */
export function defaultReportOptions(kind: ReportKind = "inspection"): ReportOptions {
  return kind === "after" ? AFTER_REPORT_OPTIONS : DEFAULT_REPORT_OPTIONS;
}

const ATTENDANCE_KEYS = ["owner", "family", "other"] as const;
const CATEGORY_KEYS = ["inspection", "after", "paid", "direct", "free"] as const;

/** 保存データ・古い形式から読み込むときの正規化 (欠けていれば既定値) */
export function normalizeReportOptions(
  raw: unknown,
  defaults: ReportOptions = DEFAULT_REPORT_OPTIONS,
): ReportOptions {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = <K extends string>(group: unknown, keys: readonly K[], defaults: Record<K, boolean>) => {
    const g = (typeof group === "object" && group !== null ? group : {}) as Record<string, unknown>;
    return Object.fromEntries(
      keys.map((k) => [k, typeof g[k] === "boolean" ? (g[k] as boolean) : defaults[k]]),
    ) as Record<K, boolean>;
  };
  return {
    attendance: pick(o.attendance, ATTENDANCE_KEYS, defaults.attendance),
    categories: pick(o.categories, CATEGORY_KEYS, defaults.categories),
  };
}

/** 指示内容の1項目 (本紙の №+本文) */
export interface InstructionItem {
  /** 丸数字。「別紙参照」の行は空 */
  no: string;
  text: string;
}

export interface ReportAppendix {
  /** 「1年目点検是正項目」など */
  title: string;
  /** 「物件名：…」 */
  propertyLine: string;
  /** 「施主名：…様」 (カナは付けない) */
  ownerLine: string;
  /** 番号付きの項目本文 (「①1階洋室 …」) */
  items: string[];
}

export interface ReportData {
  pj: string;
  /** 受付種別 (「1年」など)。別紙のタイトルに使う */
  timing: string;
  receptionDate: string;
  handoverDate: string;
  propertyName: string;
  /** 施主名 (漢字のみ。姓名間は全角スペース) */
  ownerName: string;
  ownerKana: string;
  /** 入力シートC6に入れる値。「様」は表示形式が付けるので含めない */
  ownerLine: string;
  address: string;
  phone1: string;
  phone2: string;
  receptionist: string;
  /** 指示内容の全項目 (番号なしの本文) */
  items: string[];
  /** 6件以上で別紙に回したか */
  useAppendix: boolean;
  /** 本紙の指示内容枠 (常に MAIN_SLOTS 個。余りは空) */
  main: InstructionItem[];
  appendix: ReportAppendix | null;
  options: ReportOptions;
  warnings: string[];
}

/** ResultRow のうち完了報告書に必要な部分だけ (テストから最小の入力で呼べるように) */
export interface ReportSource {
  cells: string[];
  mail: { ownerKana: string; contacts: Contact[] };
  /** 省略時は定期点検 */
  kind?: ReportKind;
  /** 点検内容を工事区分ごとに分けているとき、指示内容は各区分の本文から組み立てる */
  categories?: readonly { value: string; summary?: string }[];
  splitSummary?: boolean;
}

/**
 * 点検内容の分割・結合は lib/summary.ts に移した (結果テーブルと共用するため)。
 * 呼び出し側の import を変えずに済むよう、ここから再エクスポートする。
 */
export {
  joinSummary,
  splitInstructionItems,
  splitSummary,
  type SummaryParts,
} from "@/lib/summary";

/** 別紙のタイトル。アフターは固定、定期点検は受付種別から (空なら時期を省く) */
export function appendixTitle(timing: string, kind: ReportKind = "inspection"): string {
  if (kind === "after") return AFTER_APPENDIX_TITLE;
  const t = timing.trim();
  return t ? `${t}目点検是正項目` : "点検是正項目";
}

/** 施主名 (漢字) にカナを添えた表記。カナが無ければ括弧ごと省く */
export function buildOwnerLine(ownerName: string, ownerKana: string): string {
  const owner = toFullWidthSpace(ownerName.trim());
  const kana = toFullWidthSpace(ownerKana.trim());
  if (!owner) return "";
  return kana ? `${owner}（${kana}）` : owner;
}

export function buildReportData(row: ReportSource, options: ReportOptions): ReportData {
  const cell = (i: number) => (row.cells[i] ?? "").trim();
  const warnings: string[] = [];

  const ownerName = toFullWidthSpace(cell(OWNER_COL));
  const ownerKana = row.mail.ownerKana.trim();
  const items = splitInstructionItems(recordSummary(row));
  const useAppendix = items.length >= APPENDIX_THRESHOLD;

  const main: InstructionItem[] = Array.from({ length: MAIN_SLOTS }, (_, i) => {
    if (useAppendix) {
      // 別紙に全項目を書き、本紙は「別紙参照」の1行だけ (№は付けない)
      return i === 0 ? { no: "", text: APPENDIX_REFERENCE_TEXT } : { no: "", text: "" };
    }
    const text = items[i];
    return text ? { no: circledNumber(i + 1), text } : { no: "", text: "" };
  });

  if (items.length === 0) {
    // 呼び名は画面に合わせる (定期点検は「点検内容」、アフターメンテナンスは「アフター受付内容」)
    const summaryLabel = row.kind === "after" ? "アフター受付内容" : "点検内容";
    warnings.push(`指示内容が空です (${summaryLabel}から項目を取れませんでした)`);
  }
  if (!ownerKana) warnings.push("施主名のカナが未入力です (カナ無しで出力します)");

  const appendix: ReportAppendix | null = useAppendix
    ? {
        title: appendixTitle(cell(RECEPTION_TYPE_COL), row.kind),
        propertyLine: `物件名：${cell(PROPERTY_COL)}`,
        // 別紙は漢字のみ・姓名間は半角スペース・「様」を直結 (見本と同じ)
        ownerLine: ownerName ? `施主名：${ownerName.replace(/　/g, " ")}様` : "施主名：",
        items: items.map((text, i) => `${circledNumber(i + 1)}${text}`),
      }
    : null;

  if (useAppendix && items.length > APPENDIX_SLOTS) {
    warnings.push(
      `指示内容が${items.length}件あります。Excelの別紙シートは${APPENDIX_SLOTS}件までなので、` +
        `${APPENDIX_SLOTS + 1}件目以降は入りません (PDFは別紙のページを増やして全件載せます)`,
    );
  }

  return {
    pj: cell(PJ_COL),
    timing: cell(RECEPTION_TYPE_COL),
    receptionDate: cell(RECEPTION_DATE_COL),
    handoverDate: cell(HANDOVER_COL),
    propertyName: cell(PROPERTY_COL),
    ownerName,
    ownerKana,
    ownerLine: buildOwnerLine(ownerName, ownerKana),
    address: cell(ADDRESS_COL),
    phone1: row.mail.contacts[0]?.phone ?? "",
    phone2: row.mail.contacts[1]?.phone ?? "",
    receptionist: RECEPTIONIST,
    items,
    useAppendix,
    main,
    appendix,
    options,
    warnings,
  };
}
