/**
 * 本紙「作業報告書　兼　完了報告書」のレイアウト。
 * テンプレート (public/report/completion-report.xlsx の sheet3) の
 * 文字・配置・結合・罫線をそのまま書き写したもの。値は field で差し込む。
 */
import { MAIN_SHEET_METRICS } from "@/lib/report/metrics";
import type { CellSpec, SheetSpec, Sides } from "@/lib/report/layout/grid";

const BOX: Sides = { l: "thin", r: "thin", t: "thin", b: "thin" };
const TOP_BOTTOM: Sides = { t: "thin", b: "thin" };
/** 見出し行 (指示内容・作業内容) は下が二重線 */
const HEADER_ROW: Sides = { l: "thin", r: "thin", t: "thin", b: "double" };
/** 一覧の行は上を持たない (前の行の下罫線と重なるため) */
const LIST_ROW: Sides = { l: "thin", r: "thin", b: "thin" };

/** 会社名・作業者の欄と確認欄は太線 */
const MEDIUM_BOX: Sides = { l: "medium", r: "medium", t: "medium", b: "medium" };

const cells: CellSpec[] = [
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

  // 指示内容 (15行が見出し、16〜20行が枠)
  { ref: "B15:U15", text: "指示内容", border: HEADER_ROW },
  ...[0, 1, 2, 3, 4].flatMap((i): CellSpec[] => [
    { ref: `B${16 + i}`, field: `no${i}`, h: "center", border: LIST_ROW },
    { ref: `C${16 + i}:U${16 + i}`, field: `item${i}`, border: LIST_ROW, shrink: true },
  ]),

  // 作業内容・是正内容 (22行が見出し、23〜27行が枠。内容は空欄のまま)
  { ref: "B22:S22", text: "作業内容・是正内容", border: HEADER_ROW },
  { ref: "T22:U22", text: "完了ﾁｪｯｸ", size: 10, h: "center", border: HEADER_ROW },
  ...[0, 1, 2, 3, 4].flatMap((i): CellSpec[] => [
    { ref: `B${23 + i}`, field: `no${i}`, h: "center", border: LIST_ROW },
    { ref: `C${23 + i}:S${23 + i}`, border: LIST_ROW },
    {
      ref: `T${23 + i}:U${23 + i}`,
      checkbox: `done${i}`,
      v: "center",
      border: i === 0 ? LIST_ROW : { ...LIST_ROW, t: "thin" },
    },
  ]),

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

export const MAIN_SHEET: SheetSpec = {
  scale: MAIN_SHEET_METRICS.scale,
  // A列は非表示なので B列を原点にする
  originColumn: "B",
  x0: MAIN_SHEET_METRICS.x0,
  y0: MAIN_SHEET_METRICS.y0,
  colChars: MAIN_SHEET_METRICS.colChars,
  rowHeights: MAIN_SHEET_METRICS.rowHeights,
  header: MAIN_SHEET_METRICS.header,
  cells,
};

/** MEDIUM_BOX は将来 (帯の作り替え) 用。未使用の警告を避ける */
void MEDIUM_BOX;
