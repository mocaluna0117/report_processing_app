/**
 * 顛末書の記録（保存先の `_記録/processed.json`）を、支出報告書で使う形にする。
 *
 * ★一覧の画面（ListItem）ではなく記録を直に読む。一覧はPDFのページ数まで数えるので、件数が多いと重い。
 * ★金額は表示のままの文字列（「71,500 円」）なので数に直す。税抜が無ければ null（呼ぶ側が税込÷1.1 で概算する）。
 * ★保留中（まだ保存していない）の伝票は使わない。
 */
import { parsePropertyName } from "@/lib/rakuraku/parse/fields";
import { type ProcessedData, latestEntries } from "@/lib/tenmatsu/local/records";
import { type PjParts, parsePj } from "./pj";
import { toSerial } from "./sheets";

export interface TenmatsuEntry {
  denpyoNo: string;
  /** 顛末書№（伝票No.の数字。先頭の0は落とす） */
  no: string;
  pj: PjParts | null;
  propertyName: string;
  /** 申請日（シリアル値）。無ければ取得日 */
  appliedAt: number | null;
  payee: string;
  amountExTax: number | null;
  amountInclTax: number | null;
}

export function parseYen(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const s = text.normalize("NFKC").replace(/[,\s円¥]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}

function dateSerial(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const head = text.trim().split(/[\sT]/)[0];
  return toSerial(head.replace(/-/g, "/"));
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function toTenmatsuEntries(records: ProcessedData): TenmatsuEntry[] {
  const latest = latestEntries(records);
  const out: TenmatsuEntry[] = [];
  for (const no of records.done) {
    if (records.pending[no]) continue;
    const entry = latest.get(no);
    if (!entry) continue;
    const digits = no.normalize("NFKC").replace(/\D/g, "").replace(/^0+/, "");
    out.push({
      denpyoNo: no,
      no: digits || no,
      pj: parsePj(str(entry.pj)),
      propertyName: parsePropertyName(str(entry.where)) ?? "",
      appliedAt: dateSerial(entry.shinsei_date) ?? dateSerial(entry.at),
      payee: str(entry.payee),
      amountExTax: parseYen(entry.amount_ex_tax),
      amountInclTax: parseYen(entry.amount),
    });
  }
  return out;
}
