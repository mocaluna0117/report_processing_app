/**
 * 本紙「作業報告書　兼　完了報告書」のレイアウト。
 * テンプレート (public/report/completion-report.xlsx の sheet3) の
 * 文字・配置・結合・罫線をそのまま書き写したもの。値は field で差し込む。
 */
import type { CellSpec, SheetSpec, Sides } from "@/lib/report/layout/grid";
import type { MainRow } from "@/lib/report/layout/wrap";
import { COL_CHAR_UNIT, MAIN_SHEET_METRICS, PAD_LEFT, PAD_RIGHT, PRINT_FACTOR } from "@/lib/report/metrics";
import { MAIN_SLOTS } from "@/lib/report/model";

const BOX: Sides = { l: "thin", r: "thin", t: "thin", b: "thin" };
const TOP_BOTTOM: Sides = { t: "thin", b: "thin" };
/** 見出し行 (指示内容・作業内容) は下が二重線 */
const HEADER_ROW: Sides = { l: "thin", r: "thin", t: "thin", b: "double" };
/** 一覧の行は上を持たない (前の行の下罫線と重なるため) */
const LIST_ROW: Sides = { l: "thin", r: "thin", b: "thin" };

/** 会社名・作業者の欄と確認欄は太線 */
const MEDIUM_BOX: Sides = { l: "medium", r: "medium", t: "medium", b: "medium" };

/** 指示内容の枠 (C〜U の19列) に文字を置ける幅 (pt)。折り返しの計画と描画で同じ値を使う */
export const MAIN_ITEM_USABLE_WIDTH =
  19 * 4 * COL_CHAR_UNIT * PRINT_FACTOR * MAIN_SHEET_METRICS.scale -
  (PAD_LEFT + PAD_RIGHT) * MAIN_SHEET_METRICS.scale;

/** 5つの枠をすべて1行ずつ使う既定の割り付け (値が空のときと、6件以上で「別紙参照」のとき) */
const SINGLE_ROWS: MainRow[] = Array.from({ length: MAIN_SLOTS }, (_, i) => ({
  no: "",
  text: "",
  lines: [""],
  rowStart: i,
  rowSpan: 1,
}));

/**
 * 指示内容 (16〜20行) と作業内容 (23〜27行) の枠を、行の割り付けから作る。
 * ★長い項目は次の枠に続けて書くので、その項目の枠は縦につないだ1つのセルにする (間の罫線は引かない)。
 *   作業内容の№は指示内容と行で対応している (Excel の数式 B23=B16 と同じ) ので、同じ割り付けを写す。
 *   使わなかった枠は今までどおり1行ずつ (空)。
 */
function instructionCells(rows: readonly MainRow[]): CellSpec[] {
  const out: CellSpec[] = [];
  const used = new Set<number>();
  rows.forEach((row, k) => {
    const first = row.rowStart;
    const last = row.rowStart + row.rowSpan - 1;
    for (let r = first; r <= last; r++) used.add(r);
    out.push(
      // №は折り返した項目の1行目の横に置く (wrap で1行目に置かれる)
      { ref: `B${16 + first}:B${16 + last}`, field: `no${k}`, h: "center", border: LIST_ROW, wrap: true },
      {
        ref: `C${16 + first}:U${16 + last}`,
        field: `item${k}`,
        border: LIST_ROW,
        // 幅に入らなければ次の行へ折り返す (文字は小さくしない)。警告は「指示内容①」の形で出す
        wrap: true,
        label: `指示内容${row.no || `(${k + 1}件目)`}`,
      },
      { ref: `B${23 + first}:B${23 + last}`, field: `no${k}`, h: "center", border: LIST_ROW, wrap: true },
      { ref: `C${23 + first}:S${23 + last}`, border: LIST_ROW },
      {
        ref: `T${23 + first}:U${23 + last}`,
        checkbox: `done${k}`,
        v: "center",
        border: first === 0 ? LIST_ROW : { ...LIST_ROW, t: "thin" },
      },
    );
  });
  for (let i = 0; i < MAIN_SLOTS; i++) {
    if (used.has(i)) continue;
    out.push(
      { ref: `B${16 + i}`, h: "center", border: LIST_ROW },
      { ref: `C${16 + i}:U${16 + i}`, border: LIST_ROW },
      { ref: `B${23 + i}`, h: "center", border: LIST_ROW },
      { ref: `C${23 + i}:S${23 + i}`, border: LIST_ROW },
      {
        ref: `T${23 + i}:U${23 + i}`,
        v: "center",
        border: i === 0 ? LIST_ROW : { ...LIST_ROW, t: "thin" },
      },
    );
  }
  return out;
}

const cellsBefore: CellSpec[] = [
  // 右上の社名 (右寄せ・セルからはみ出して左へ伸びる)
  { ref: "U1", text: "タカマツビルド　株式会社", h: "right" },
  { ref: "U2", text: "アフターメンテナンス課", h: "right" },
  { ref: "U3", text: "TEL：03-6271-6209　FAX：03-6271-6219", h: "right" },

  // 物件情報 (5〜9行)
  { ref: "B5:C5", text: "PJコード", border: BOX },
  { ref: "D5:L5", field: "pj", border: BOX, shrink: true },
  { ref: "M5:N5", text: "引渡日", border: BOX },
  { ref: "O5:U5", field: "handoverDate", border: BOX, shrink: true },
  { ref: "B6:C6", text: "物件名", border: BOX },
  { ref: "D6:U6", field: "propertyName", border: BOX, shrink: true },
  { ref: "B7:C7", text: "施主名", border: BOX },
  { ref: "D7:U7", field: "ownerLine", border: BOX, shrink: true },
  { ref: "B8:C8", text: "住所", border: BOX },
  { ref: "D8:U8", field: "address", border: BOX, shrink: true },
  { ref: "B9:C9", text: "連絡先①", border: BOX },
  { ref: "D9:L9", field: "phone1", border: BOX, shrink: true },
  { ref: "M9:N9", text: "連絡先②", border: BOX },
  { ref: "O9:U9", field: "phone2", border: BOX, shrink: true },

  // 立会 (11行)
  { ref: "B11:C11", text: "立会", border: BOX },
  { ref: "D11", checkbox: "attendance.owner", border: { l: "thin", ...TOP_BOTTOM } },
  { ref: "E11:F11", text: "施主", border: TOP_BOTTOM },
  { ref: "G11", checkbox: "attendance.family", border: TOP_BOTTOM },
  { ref: "H11", text: "施主ご家族", border: TOP_BOTTOM },
  { ref: "I11:J11", border: TOP_BOTTOM },
  { ref: "K11", checkbox: "attendance.other", border: TOP_BOTTOM },
  { ref: "L11", text: "その他（　　　　　　　　　）", border: TOP_BOTTOM },
  { ref: "M11:T11", border: TOP_BOTTOM },
  { ref: "U11", border: { r: "thin", ...TOP_BOTTOM } },

  // 受付項目 (12行)
  { ref: "B12:C12", text: "受付項目", border: BOX },
  { ref: "D12", checkbox: "categories.inspection", border: { l: "thin", ...TOP_BOTTOM } },
  { ref: "E12", text: "点検", border: TOP_BOTTOM },
  { ref: "F12", border: TOP_BOTTOM },
  { ref: "G12", checkbox: "categories.after", border: TOP_BOTTOM },
  { ref: "H12", text: "アフター", border: TOP_BOTTOM },
  { ref: "I12:J12", border: TOP_BOTTOM },
  { ref: "K12", checkbox: "categories.paid", border: TOP_BOTTOM },
  { ref: "L12", text: "有償工事", border: TOP_BOTTOM },
  { ref: "M12", border: TOP_BOTTOM },
  { ref: "N12", checkbox: "categories.direct", border: TOP_BOTTOM },
  { ref: "O12", text: "直収対応", border: TOP_BOTTOM },
  { ref: "P12", border: TOP_BOTTOM },
  { ref: "Q12", checkbox: "categories.free", border: TOP_BOTTOM },
  { ref: "R12", text: "無償対応", border: TOP_BOTTOM },
  { ref: "S12:T12", border: TOP_BOTTOM },
  { ref: "U12", border: { r: "thin", ...TOP_BOTTOM } },

  // 受付日・受付者 (13行)
  { ref: "B13:C13", text: "受付日", border: BOX },
  { ref: "D13:J13", field: "receptionDate", border: BOX, shrink: true },
  { ref: "K13:L13", text: "受付者", border: BOX },
  { ref: "M13:U13", field: "receptionist", border: BOX, shrink: true },

  // 指示内容 (15行が見出し) と作業内容 (22行が見出し)。
  // 16〜20行・23〜27行の枠は instructionCells が行の割り付けから作る
  { ref: "B15:U15", text: "指示内容", border: HEADER_ROW },
  { ref: "B22:S22", text: "作業内容・是正内容", border: HEADER_ROW },
  { ref: "T22:U22", text: "完了ﾁｪｯｸ", size: 10, h: "center", border: HEADER_ROW },
];

const cellsAfter: CellSpec[] = [
  // 会社名・作業者 (29行)
  {
    ref: "B29:L29",
    text: "会社名：　　　　　　　　　　　　　　　　　　",
    underline: true,
    border: { l: "medium", t: "medium", b: "medium" },
  },
  {
    ref: "M29:U29",
    text: "作業者：　　　　　　　　　　　　　　",
    underline: true,
    border: { r: "medium", t: "medium", b: "medium" },
  },
  // 30行は間隔をあけるだけの帯 (上下だけ太線)
  { ref: "B30:U30", border: { t: "medium", b: "medium" } },

  // 確認欄 (31〜33行)
  { ref: "B31", text: "◎上記作業内容もしくは是正工事が完了したことを確認しました。" },
  { ref: "B31:U31", border: { l: "medium", r: "medium" } },
  { ref: "P32:Q32", text: "年", h: "right" },
  { ref: "R32:S32", text: "月", h: "right" },
  // 左隣の「年」「月」の欄が埋まっているため、Excelでは U列に収まる「日」しか表示されない
  { ref: "U32", text: "　　年　　　月　　　日", h: "right", clipToCell: true },
  { ref: "B32:U32", border: { l: "medium", r: "medium" } },
  {
    ref: "U33",
    text: "お客様ご署名　　　　　　　　　　　　　　印　　",
    h: "right",
    underline: true,
  },
  { ref: "B33:U33", border: { l: "medium", r: "medium", b: "medium" } },
];

/** 本紙の仕様を、指示内容の行の割り付けから作る (差し込む値は no0../item0../done0.. で rows の順) */
export function mainSheet(rows: readonly MainRow[] = SINGLE_ROWS): SheetSpec {
  return {
    scale: MAIN_SHEET_METRICS.scale,
    // A列は非表示なので B列を原点にする
    originColumn: "B",
    x0: MAIN_SHEET_METRICS.x0,
    y0: MAIN_SHEET_METRICS.y0,
    colChars: MAIN_SHEET_METRICS.colChars,
    rowHeights: MAIN_SHEET_METRICS.rowHeights,
    header: MAIN_SHEET_METRICS.header,
    cells: [...cellsBefore, ...instructionCells(rows), ...cellsAfter],
  };
}

/** 5枠すべて1行ずつの既定 (見本と同じ形。6件以上で「別紙参照」のときもこれ) */
export const MAIN_SHEET: SheetSpec = mainSheet();

/** MEDIUM_BOX は将来 (帯の作り替え) 用。未使用の警告を避ける */
void MEDIUM_BOX;
