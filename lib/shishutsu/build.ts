/**
 * 支出報告書の中身を組み立てる（純関数。Excel にする前の形）。
 *
 * 業務の決まり（2026-10-03 に利用者と確認）:
 *   - 載せる月は進捗管理表の**完了日**で決める。現場対応なしは完了日が空なので**受付日**（完了日の欄にも受付日）
 *   - 現場対応なしの表に混ざる点検の行（受付種別が「1年」「2年」「3ヶ月」など）は載せない
 *   - エンド立会は**内覧会日**がその月の行を全部（完了日の欄＝内覧会日、引渡日の欄＝決済日、担当＝最終確認の担当）
 *   - **物件引渡日が 2019/5/31 以前**なら RIZAP対象、それより後は対象外。引渡日が分からなければ RIZAP対象
 *   - 顛末書は **PJ（無ければ物件名）が同じで、申請日がその受付の受付日以降**のものを結ぶ。1本の顛末書は1つの受付にだけ
 *   - 顛末書1本＝1行（同じ受付に2本以上なら № を 3-1, 3-2 … と枝分けする）。原価は支払金額(税抜)
 *   - 受注（その他・保険・相殺）は自動では決められないので 0（Excel で直す）
 *   - 担当者別の件数は**受付1件ずつ**数え、2人の連名なら 0.5 ずつ
 */
import { type PjParts, pjKey } from "./pj";
import { type EndRow, type ProgressCase, type ProgressRow, dateOf, groupCases, serialOf } from "./sheets";
import type { TenmatsuEntry } from "./tenmatsu";

/** 担当者別件数の表の名簿（見本の並び。2026-10-03 時点） */
export const STAFF_ROSTER = ["丸山", "岩野", "大場", "松廣", "山下", "木村", "保険", "工事部"] as const;

/** RIZAP対象の境目（この日までに引き渡した物件） */
export const RIZAP_LAST_HANDOVER = serialOf(2019, 5, 31);

export type SectionKey = "rizap" | "other" | "end";

export interface ReportRow {
  no: string;
  /** 物件引渡日（シリアル値）。分からなければ null（「不明」と書く） */
  handoverAt: number | null;
  completedAt: number | null;
  division: number | null;
  pj: number | null;
  site: number | null;
  branch: number | null;
  propertyName: string;
  category: string;
  summary: string;
  cost: number;
  staff: string;
  note: string;
  /** 原価を税込÷1.1 で概算したか */
  estimated: boolean;
}

export interface ReportSection {
  key: SectionKey;
  label: string;
  rows: ReportRow[];
  /** 受付の件数（№ の数） */
  cases: number;
}

export interface StaffCount {
  name: string;
  rizap: number;
  other: number;
  end: number;
}

export interface ExpenseReport {
  year: number;
  month: number;
  title: string;
  sections: ReportSection[];
  staff: StaffCount[];
  /** 原価の合計 */
  totalCost: number;
  warnings: string[];
}

export interface BuildInput {
  year: number;
  month: number;
  after: readonly ProgressRow[];
  noSite: readonly ProgressRow[];
  /** 年次点検進捗管理表。選ばなかったら null */
  inspection: readonly ProgressRow[] | null;
  end: readonly EndRow[];
  tenmatsu: readonly TenmatsuEntry[];
}

const SECTION_LABELS: Record<SectionKey, string> = { rizap: "RIZAP対象", other: "RIZAP対象外", end: "エンド立会" };

/** 物件名をくらべる形に（空白・全角半角・「様邸」「様」を落とす） */
export function propertyKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[\s　]/g, "")
    .replace(/(様邸|様|邸)$/u, "")
    .replace(/新築工事$/u, "");
}

function sameProperty(a: string, b: string): boolean {
  const x = propertyKey(a);
  const y = propertyKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.includes(short);
}

/** 担当の欄から名前を取り出す（役職・敬称を落とし、連名は分ける） */
export function normalizeStaff(text: string): string[] {
  return text
    .normalize("NFKC")
    .split(/[・、,，/／\n\r\t ]+|　/)
    .map((s) => s.replace(/[（(][^）)]*[）)]/g, "").replace(/(本部長|部長|課長|係長|主任|さん|様)$/u, "").trim())
    .filter((s) => s !== "");
}

const INSPECTION_TYPE = /^(\d+(年|ヶ月|か月|カ月|ケ月)|半年)$/u;

/** 年次点検の受付種別 → 区分（1年 → 1T、3ヶ月 → ３ヶ月） */
export function inspectionCategory(receptionType: string): string {
  const t = receptionType.normalize("NFKC").trim();
  const year = /^(\d+)年$/.exec(t);
  if (year) return `${year[1]}T`;
  const months = /^(\d+)(ヶ月|か月|カ月|ケ月)$/.exec(t);
  if (months) return `${months[1].replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)))}ヶ月`;
  return t || "点検";
}

/** 受付内容の1行目（「【受付内容】」のような見出しだけの行は飛ばす） */
export function firstLine(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || /^【[^】]*】$/.test(s)) continue;
    return s.replace(/^【[^】]*】/, "").trim() || s;
  }
  return "";
}

/** 現場対応なしの備考（処置の文から、電話・SMS・メール・書類のどれで対応したかを拾う） */
export function channelNote(action: string): string {
  const t = action.normalize("NFKC");
  const found: string[] = [];
  if (/電話|TEL|架電|折り返し/i.test(t)) found.push("電話");
  if (/SMS|ショートメール/i.test(t)) found.push("SMS");
  if (/メール/.test(t.replace(/ショートメール/g, ""))) found.push("メール");
  if (/書類|郵送|送付|発行/.test(t)) return found.length ? `${found.join("・")}・書類送付` : "書類送付";
  return found.length ? `${found.join("・")}対応のみ` : "";
}

interface Unit {
  section: SectionKey;
  source: "after" | "inspection" | "noSite" | "end";
  order: number;
  completedAt: number | null;
  /** 顛末書の申請日とくらべる日（受付日。エンドは内覧会日の45日前） */
  sinceAt: number | null;
  handoverAt: number | null;
  pj: PjParts | null;
  propertyName: string;
  category: string;
  content: string;
  staff: string[];
  baseNote: string;
  tenmatsu: TenmatsuEntry[];
}

const inMonth = (serial: number | null, year: number, month: number) => {
  if (serial === null) return false;
  const [y, m] = dateOf(serial);
  return y === year && m === month;
};

const sectionOf = (handoverAt: number | null): SectionKey =>
  handoverAt === null || handoverAt <= RIZAP_LAST_HANDOVER ? "rizap" : "other";

function fromCase(c: ProgressCase, order: number): Unit {
  const head = c.head;
  const source = c.source;
  const category =
    source === "inspection"
      ? inspectionCategory(head.receptionType)
      : source === "after" && /雨漏/.test(c.rows.map((r) => r.workCategory).join(" "))
        ? "雨漏れ"
        : source === "after" && /エンド立会/.test(head.workCategory)
          ? "エンド立会"
          : "A";
  const completedAt = source === "noSite" ? c.receivedAt : c.completedAt;
  return {
    section: sectionOf(head.handoverAt),
    source,
    order,
    completedAt,
    sinceAt: c.receivedAt,
    handoverAt: head.handoverAt,
    pj: head.pj,
    propertyName: head.propertyName,
    category,
    content: head.content,
    staff: normalizeStaff(c.rows.map((r) => r.staff).find((s) => s.trim() !== "") ?? ""),
    baseNote: source === "noSite" ? channelNote(c.rows.map((r) => r.action).join("\n")) : head.vendor,
    tenmatsu: [],
  };
}

function fromEnd(row: EndRow, order: number): Unit {
  return {
    section: "end",
    source: "end",
    order,
    completedAt: row.previewAt,
    sinceAt: row.previewAt === null ? null : row.previewAt - 45,
    handoverAt: row.settledAt,
    pj: row.pj,
    propertyName: row.propertyName,
    category: "エンド立会",
    content: "",
    staff: normalizeStaff(row.staff),
    baseNote: "",
    tenmatsu: [],
  };
}

/**
 * 顛末書を受付に結ぶ。候補は「PJ が同じ（どちらかに PJ が無ければ物件名が同じ）で、申請日 ≥ 受付日」の受付。
 * 候補が複数なら、申請日にいちばん近い（受付日がいちばん新しい）受付へ。
 * ★現場対応なしの受付には結ばない（支出が無いもの）。
 */
function attach(units: Unit[], tenmatsu: readonly TenmatsuEntry[]): TenmatsuEntry[] {
  const unmatched: TenmatsuEntry[] = [];
  for (const t of tenmatsu) {
    const tKey = pjKey(t.pj);
    let best: Unit | null = null;
    for (const u of units) {
      if (u.source === "noSite") continue;
      const uKey = pjKey(u.pj);
      const matches = tKey && uKey ? tKey === uKey : sameProperty(t.propertyName, u.propertyName);
      if (!matches) continue;
      if (t.appliedAt !== null && u.sinceAt !== null && t.appliedAt < u.sinceAt) continue;
      if (!best || (u.sinceAt ?? -Infinity) > (best.sinceAt ?? -Infinity)) best = u;
    }
    if (best) best.tenmatsu.push(t);
    else unmatched.push(t);
  }
  return unmatched;
}

function rowsOf(u: Unit, n: number): ReportRow[] {
  const base = {
    handoverAt: u.handoverAt,
    completedAt: u.completedAt,
    division: u.pj?.division ?? null,
    pj: u.pj?.pj ?? null,
    site: u.pj?.site ?? null,
    propertyName: u.propertyName,
    category: u.category,
    staff: u.staff.join("・"),
  };
  const head = firstLine(u.content) || (u.source === "end" ? "エンド立会" : "");
  if (u.tenmatsu.length === 0) {
    return [{ ...base, no: String(n), branch: null, summary: head, cost: 0, note: u.baseNote, estimated: false }];
  }
  const list = [...u.tenmatsu].sort((a, b) => (a.appliedAt ?? 0) - (b.appliedAt ?? 0) || a.no.localeCompare(b.no));
  return list.map((t, i) => {
    const estimated = t.amountExTax === null;
    const cost = t.amountExTax ?? (t.amountInclTax === null ? 0 : Math.round(t.amountInclTax / 1.1));
    return {
      ...base,
      no: list.length > 1 ? `${n}-${i + 1}` : String(n),
      branch: t.pj?.branch ?? null,
      summary: `${head}（顛末書№${t.no}）`,
      cost,
      note: [t.payee, estimated ? "※税抜は概算" : ""].filter(Boolean).join("　"),
      estimated,
    };
  });
}

const fmtDate = (serial: number) => {
  const [y, m, d] = dateOf(serial);
  return `${y}/${m}/${d}`;
};

export function buildExpenseReport(input: BuildInput): ExpenseReport {
  const { year, month } = input;
  const warnings: string[] = [];
  const isInspectionRow = (r: ProgressRow) => INSPECTION_TYPE.test(r.receptionType.normalize("NFKC").trim());

  let order = 0;
  const units: Unit[] = [
    ...groupCases(input.after).map((c) => fromCase(c, order++)),
    ...groupCases(input.inspection ?? []).map((c) => fromCase(c, order++)),
    ...groupCases(input.noSite.filter((r) => !isInspectionRow(r))).map((c) => fromCase(c, order++)),
    ...input.end.map((r) => fromEnd(r, order++)),
  ];
  const unmatched = attach(units, input.tenmatsu);

  const monthStart = serialOf(year, month, 1);
  const monthEnd = serialOf(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) - 1;
  for (const t of unmatched) {
    if (t.appliedAt === null || t.appliedAt < monthStart - 90 || t.appliedAt > monthEnd) continue;
    warnings.push(
      `顛末書№${t.no}（${t.propertyName || "物件名なし"}・申請 ${fmtDate(t.appliedAt)}）が、進捗管理表のどの行にも結びつきませんでした`,
    );
  }

  const picked = units.filter((u) => inMonth(u.completedAt, year, month));
  const sections: ReportSection[] = (["rizap", "other", "end"] as const).map((key) => {
    const list = picked
      .filter((u) => u.section === key)
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0) || a.order - b.order);
    return { key, label: SECTION_LABELS[key], rows: list.flatMap((u, i) => rowsOf(u, i + 1)), cases: list.length };
  });

  const staff: StaffCount[] = STAFF_ROSTER.map((name) => ({ name, rizap: 0, other: 0, end: 0 }));
  const unknownStaff = new Set<string>();
  for (const u of picked) {
    if (u.staff.length === 0) continue;
    const share = 1 / u.staff.length;
    for (const name of u.staff) {
      const slot = staff.find((s) => s.name === name);
      if (!slot) {
        unknownStaff.add(name);
        continue;
      }
      slot[u.section] += share;
    }
  }
  if (unknownStaff.size > 0) {
    warnings.push(`担当者別の件数の表に無い担当がいました（数えていません）: ${[...unknownStaff].join("、")}`);
  }
  const noStaff = picked.filter((u) => u.staff.length === 0).length;
  if (noStaff > 0) warnings.push(`担当が空の受付が ${noStaff}件あります（担当者別の件数に入っていません）`);

  const rows = sections.flatMap((s) => s.rows);
  const estimated = rows.filter((r) => r.estimated).length;
  if (estimated > 0) {
    warnings.push(
      `支払金額(税抜)が記録に無い顛末書 ${estimated}件は、税込÷1.1 で概算しました（顛末書タブの「税抜を読み直す」で正確な値になります）`,
    );
  }
  const noHandover = picked.filter((u) => u.section === "rizap" && u.handoverAt === null).length;
  if (noHandover > 0) {
    warnings.push(`引渡日が空の受付 ${noHandover}件は、RIZAP対象の表に「不明」として入れました（違っていれば Excel で移してください）`);
  }
  const noPj = picked.filter((u) => u.pj === null).length;
  if (noPj > 0) warnings.push(`PJ を読めない受付が ${noPj}件あります（事業部ｺｰﾄﾞ・PJ・現場コードが空欄です）`);
  if (input.inspection === null) {
    warnings.push("年次点検進捗管理表を選んでいないので、1T・2T・３ヶ月の行は入っていません");
  }

  return {
    year,
    month,
    title: `${year}年　${month}月度　　アフターメンテナンス課　支出報告書`,
    sections,
    staff,
    totalCost: rows.reduce((n, r) => n + r.cost, 0),
    warnings,
  };
}

/** ダウンロードするファイルの名前（見本と同じ。年の後ろは半角の空白、【 の前は全角の空白） */
export function expenseFileName(year: number, month: number): string {
  return `${year}年 ${month}月度支出報告　【アフターメンテナンス課】.xlsx`;
}
