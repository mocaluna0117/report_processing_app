// 監督・営業を PJコードの上8桁で突き合わせる純関数。IndexedDB にも画面にも触らない。
//
// 使う向きは2つある。**キーの作り方と「食い違ったら書かない」規則は共通**:
//   1. 顛末書 → お客様の情報   (buildStaffSync)   … 顛末書タブの反映欄
//   2. お客様の情報 → 定期点検の行 (buildRowStaff) … 抽出結果の「監督・営業を反映」
//
// なぜ上8桁か: PJの下2桁は同じ現場の枝番 (棟) で、顛末書と顧客データで
// 別の枝番を指していることがある。上8桁が「現場」を表す。
import { baseFields, effectiveFields } from "@/lib/after/customer";
import { reportPj } from "@/lib/after/match-report";
import type { Customer } from "@/lib/after/types";
import type { ResultRow } from "@/lib/process";
import { PJ_COL, SALES_COL, SUPERVISOR_COL } from "@/lib/tsv";
import type { ListItem } from "@/lib/tenmatsu/client";
import { trimWide } from "@/lib/text";

/** 突き合わせに使うPJの桁数 (下2桁は棟の枝番なので落とす) */
export const PJ_PREFIX_LENGTH = 8;

/** 反映する項目。お客様の情報のキー名と同じにしてある */
export type StaffField = "supervisor" | "salesRep";

export const STAFF_FIELDS: readonly { key: StaffField; label: string }[] = [
  { key: "supervisor", label: "監督" },
  { key: "salesRep", label: "営業" },
];

/** PJ (10桁) の上8桁。10桁として読めなければ null */
export function pjPrefix(pj: string | null | undefined): string | null {
  const ten = reportPj(pj ?? "");
  return ten ? ten.slice(0, PJ_PREFIX_LENGTH) : null;
}

/** 上8桁 → その現場の顧客 (同じ現場に複数の棟が登録されていることがある) */
export function indexCustomersByPjPrefix(
  customers: readonly Customer[],
): Map<string, Customer[]> {
  const map = new Map<string, Customer[]>();
  for (const customer of customers) {
    const key = pjPrefix(effectiveFields(customer).pj);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(customer);
    else map.set(key, [customer]);
  }
  return map;
}

/** 空白を落として比べる (「架空　一郎」と「架空 一郎」を同じ値と見なす) */
const staffKey = (value: string | null | undefined) =>
  trimWide(value ?? "").replace(/[\s　]+/g, "");

/**
 * 候補の値を1つに決める。**食い違ったら決めない** (利用者の指定)。
 * 空の値は候補にしない (同じ現場で1棟だけ入っている状態を「食い違い」にしないため)。
 */
export function resolveStaffValue(values: readonly (string | null | undefined)[]): {
  value: string | null;
  /** 空でない値が2種類以上あった */
  conflict: boolean;
  /** 画面に出す用の、食い違った値 */
  candidates: string[];
} {
  const seen = new Map<string, string>();
  for (const raw of values) {
    const key = staffKey(raw);
    if (!key) continue;
    if (!seen.has(key)) seen.set(key, trimWide(raw ?? ""));
  }
  const candidates = [...seen.values()];
  if (candidates.length === 0) return { value: null, conflict: false, candidates };
  if (candidates.length > 1) return { value: null, conflict: true, candidates };
  return { value: candidates[0], conflict: false, candidates };
}

// --------------------------------------------------------------------------
// 1. 顛末書 → お客様の情報
// --------------------------------------------------------------------------

export type StaffSyncStatus =
  /** 入れられる (お客様の情報が空欄) */
  | "update"
  /** 同じ値が既に入っている */
  | "same"
  /** 別の値が入っているので触らない (点検保守台帳の営業・手直しなど) */
  | "kept"
  /** 顛末書どうし、またはお客様どうしで値が食い違う → 見送り */
  | "conflict"
  /** 顛末書に監督・営業が書かれていない */
  | "empty";

export interface StaffSyncField {
  /** 顛末書から読んだ値 (食い違い・空なら null) */
  incoming: string | null;
  /** お客様の情報に今入っている値 (複数いるときは代表) */
  current: string;
  status: StaffSyncStatus;
  reason: string;
}

export interface StaffSyncRow {
  /** PJの上8桁。行のキー */
  key: string;
  /** 元になった顛末書 */
  denpyoNos: string[];
  /** 上8桁が一致したお客様 (0件なら見つからなかった) */
  customers: Customer[];
  fields: Record<StaffField, StaffSyncField>;
  /** 実際に書く分。空なら押しても何も起きない */
  updates: StaffUpdate[];
}

export interface StaffUpdate {
  id: string;
  supervisor?: string;
  salesRep?: string;
}

export interface StaffSyncResult {
  rows: StaffSyncRow[];
  /** PJを読めなかった顛末書の件数 (黙って隠さず件数で伝える) */
  skippedNoPj: number;
  /** 監督も営業も書かれていなかった顛末書の件数 */
  skippedNoStaff: number;
  /** PC側のサーバーがこの項目に対応しているか */
  serverSupported: boolean;
}

/** このPCのサーバーが監督・営業に対応しているか (未対応なら値なしと区別する) */
export function hasStaffFields(item: ListItem): boolean {
  return "pj" in item;
}

const staffFromItem = (item: ListItem, field: StaffField): string | null =>
  field === "supervisor" ? (item.supervisor ?? null) : (item.sales_rep ?? null);

/**
 * 顛末書の一覧とお客様の情報から、監督・営業の反映の計画を組み立てる。
 * 行は**PJの上8桁ごと**にまとめる (同じ現場の顛末書が何件あっても1行)。
 */
export function buildStaffSync(
  items: readonly ListItem[],
  customers: readonly Customer[],
): StaffSyncResult {
  const serverSupported = items.length === 0 || items.some(hasStaffFields);
  const index = indexCustomersByPjPrefix(customers);
  const groups = new Map<string, ListItem[]>();
  let skippedNoPj = 0;
  let skippedNoStaff = 0;

  for (const item of items) {
    const key = pjPrefix(item.pj);
    if (!key) {
      skippedNoPj += 1;
      continue;
    }
    if (!staffKey(item.supervisor) && !staffKey(item.sales_rep)) {
      skippedNoStaff += 1;
      continue;
    }
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }

  const rows: StaffSyncRow[] = [];
  for (const [key, group] of groups) {
    const matched = index.get(key) ?? [];
    const fields = {} as Record<StaffField, StaffSyncField>;
    // 顧客ごとに書く値をためる (項目が2つあるので1顧客1件にまとめる)
    const perCustomer = new Map<string, StaffUpdate>();

    for (const { key: field, label } of STAFF_FIELDS) {
      const incoming = resolveStaffValue(group.map((i) => staffFromItem(i, field)));
      const currents = matched.map((c) => effectiveFields(c)[field] ?? "");
      const current = currents.find((v) => staffKey(v)) ?? "";

      if (incoming.conflict) {
        fields[field] = {
          incoming: null,
          current,
          status: "conflict",
          reason: `顛末書ごとに${label}が違います (${incoming.candidates.join(" / ")})`,
        };
        continue;
      }
      if (!incoming.value) {
        fields[field] = {
          incoming: null,
          current,
          status: "empty",
          reason: `顛末書に${label}が書かれていません`,
        };
        continue;
      }
      // お客様側に入っている値。★1つでも別の値があれば触らない
      const existing = resolveStaffValue(currents);
      if (existing.conflict) {
        fields[field] = {
          incoming: incoming.value,
          current,
          status: "conflict",
          reason: `お客様ごとに${label}が違います (${existing.candidates.join(" / ")})`,
        };
        continue;
      }
      if (existing.value && staffKey(existing.value) !== staffKey(incoming.value)) {
        fields[field] = {
          incoming: incoming.value,
          current: existing.value,
          status: "kept",
          reason: `お客様の情報に別の${label}が入っています (${existing.value})`,
        };
        continue;
      }
      const blanks = matched.filter((c) => !staffKey(effectiveFields(c)[field]));
      if (blanks.length === 0) {
        fields[field] = {
          incoming: incoming.value,
          current,
          status: matched.length > 0 ? "same" : "empty",
          reason: matched.length > 0 ? `同じ${label}が入っています` : "お客様が見つかりません",
        };
        continue;
      }
      for (const customer of blanks) {
        const update = perCustomer.get(customer.id) ?? { id: customer.id };
        update[field] = incoming.value;
        perCustomer.set(customer.id, update);
      }
      fields[field] = {
        incoming: incoming.value,
        current,
        status: "update",
        reason: `お客様の情報が空欄なので${label}を入れます`,
      };
    }

    rows.push({
      key,
      denpyoNos: group.map((i) => i.denpyo_no),
      customers: matched,
      fields,
      updates: [...perCustomer.values()],
    });
  }

  return { rows, skippedNoPj, skippedNoStaff, serverSupported };
}

/** 反映できる分だけを畳む (行ごと・まとめて反映の両方から使う) */
export function staffUpdatesFor(rows: readonly StaffSyncRow[]): StaffUpdate[] {
  return rows.flatMap((row) => row.updates);
}

// --------------------------------------------------------------------------
// 2. お客様の情報 → 定期点検の行
// --------------------------------------------------------------------------

export type RowStaffStatus =
  /** 入れられる (行の列が空欄) */
  | "ready"
  /** 同じ値が既に入っている */
  | "filled"
  /** 行に別の値が手入力されているので触らない */
  | "kept"
  /** お客様ごとに値が違う → 見送り */
  | "conflict"
  /** お客様の情報に監督・営業が入っていない */
  | "missing"
  /** 上8桁が一致するお客様がいない */
  | "unmatched"
  /** PJを10桁として読めない */
  | "invalid";

export interface RowStaffPlan {
  pairId: string;
  pj: string | null;
  /** 実際に書き換えるセル。空なら押せない */
  updates: { col: number; value: string }[];
  status: RowStaffStatus;
  reason: string;
}

const ROW_TARGETS: readonly { key: StaffField; col: number; label: string }[] = [
  { key: "supervisor", col: SUPERVISOR_COL, label: "監督" },
  { key: "salesRep", col: SALES_COL, label: "営業" },
];

/**
 * 抽出結果の各行に、お客様の情報から監督・営業を入れる計画を組み立てる。
 * **手入力済みの値は上書きしない**（現場を見て直した値を黙って戻さないため）。
 */
export function buildRowStaff(
  rows: readonly ResultRow[],
  customers: readonly Customer[],
): RowStaffPlan[] {
  const index = indexCustomersByPjPrefix(customers);
  return rows
    .filter((row) => !row.error)
    .map((row) => {
      const cell = row.cells[PJ_COL] ?? "";
      const pj = reportPj(cell);
      const key = pjPrefix(pj);
      if (!key) {
        return {
          pairId: row.pairId,
          pj: null,
          updates: [],
          status: "invalid" as const,
          reason: `PJを10桁として読めません (${trimWide(cell) || "空欄"})`,
        };
      }
      const matched = index.get(key) ?? [];
      if (matched.length === 0) {
        return {
          pairId: row.pairId,
          pj,
          updates: [],
          status: "unmatched" as const,
          reason: `PJの上8桁 (${key}) が一致するお客様がいません`,
        };
      }

      const updates: { col: number; value: string }[] = [];
      const reasons: string[] = [];
      let conflict = false;
      let kept = false;
      let filled = 0;
      let missing = 0;

      for (const { key: field, col, label } of ROW_TARGETS) {
        const got = resolveStaffValue(matched.map((c) => effectiveFields(c)[field]));
        if (got.conflict) {
          conflict = true;
          reasons.push(`お客様ごとに${label}が違います (${got.candidates.join(" / ")})`);
          continue;
        }
        if (!got.value) {
          missing += 1;
          reasons.push(`お客様の情報に${label}が入っていません`);
          continue;
        }
        const current = trimWide(row.cells[col] ?? "");
        if (!current) {
          updates.push({ col, value: got.value });
          continue;
        }
        if (staffKey(current) === staffKey(got.value)) {
          filled += 1;
          continue;
        }
        kept = true;
        reasons.push(`${label}は手入力済みなので入れません (お客様の情報: ${got.value})`);
      }

      const status: RowStaffStatus = updates.length > 0
        ? "ready"
        : conflict
          ? "conflict"
          : kept
            ? "kept"
            : missing === ROW_TARGETS.length
              ? "missing"
              : filled > 0
                ? "filled"
                : "missing";
      const reason = updates.length > 0
        ? `監督・営業を入れます (${updates.length}件)`
        : reasons.join(" / ") || "監督・営業は入っています";
      return { pairId: row.pairId, pj, updates, status, reason };
    });
}
