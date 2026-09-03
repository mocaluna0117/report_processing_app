/**
 * 定期点検の写真報告書 (結果テーブルの行) と、アフターメンテナンスの顧客データの照合。純関数のみ。
 *
 * 引渡日は「報告書 > 取り込んだxlsx」の順で確かなので、照合できた顧客の引渡日を報告書の値で直す。
 * 照合の手がかりは重複解消 (lib/after/dedup.ts) と同じ正規化を使う。
 */
import { effectiveFields, isReportHandover } from "@/lib/after/customer";
import { addressKey, compareAddress, nameKey, unitToken } from "@/lib/after/dedup";
import { normalizeHandoverDate } from "@/lib/after/normalize";
import type { Customer, CustomerFields } from "@/lib/after/types";
import type { ResultRow } from "@/lib/process";
import { toHalfWidthAlnum, trimWide } from "@/lib/text";
import {
  ADDRESS_COL,
  HANDOVER_COL,
  OWNER_COL,
  PJ_COL,
  PROPERTY_COL,
} from "@/lib/tsv";

/** exact: 手がかりが揃っている / probable: 1つしか無い・裏取りできない / none: 決められない */
export type MatchConfidence = "exact" | "probable" | "none";

export interface CustomerMatch {
  customer: Customer | null;
  confidence: MatchConfidence;
  /** 画面に出す根拠 */
  reason: string;
  /** 決め切れなかったときの候補 (画面に名前を並べる) */
  alternatives?: Customer[];
}

/** update: 直せる / same: 同じ / invalid: 報告書の引渡日が読めない / unmatched・ambiguous: 顧客が決まらない */
export type HandoverStatus = "update" | "same" | "invalid" | "unmatched" | "ambiguous";

export interface HandoverSyncItem {
  pairId: string;
  ownerDisplay: string;
  /** 報告書のPJ (10桁に正規化できたもの) */
  pj: string | null;
  /** 報告書の引渡日 (読めなければ null) */
  reportDate: string | null;
  /** 顧客データの引渡日 */
  customerDate: string | null;
  match: CustomerMatch;
  status: HandoverStatus;
  /** まとめて更新してよいか */
  autoApplicable: boolean;
  /** まとめて更新の対象にしない理由 */
  holdReason?: string;
}

interface CustomerKeys {
  customer: Customer;
  fields: CustomerFields;
  pj: string;
  name: string;
  address: string;
  unit: string;
}

export interface CustomerIndex {
  byPj: Map<string, CustomerKeys[]>;
  byName: Map<string, CustomerKeys[]>;
}

const push = (map: Map<string, CustomerKeys[]>, key: string, value: CustomerKeys) => {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/** 顧客一覧を照合用に索引する (数千件あるので1回だけ作って使い回す) */
export function indexCustomers(customers: readonly Customer[]): CustomerIndex {
  const byPj = new Map<string, CustomerKeys[]>();
  const byName = new Map<string, CustomerKeys[]>();
  for (const customer of customers) {
    const fields = effectiveFields(customer);
    const keys: CustomerKeys = {
      customer,
      fields,
      pj: fields.pj ?? "",
      name: nameKey(fields.ownerName),
      address: addressKey(fields.address),
      unit: unitToken(fields.propertyName),
    };
    push(byPj, keys.pj, keys);
    push(byName, keys.name, keys);
  }
  return { byPj, byName };
}

/** 報告書のPJ (10桁の数字だけを受け付ける。手入力の全角も拾う) */
export function reportPj(cell: string): string | null {
  const pj = toHalfWidthAlnum(trimWide(cell)).replace(/[\s　-]/g, "");
  return /^\d{10}$/.test(pj) ? pj : null;
}

interface RowKeys {
  pj: string | null;
  name: string;
  address: string;
  unit: string;
}

function rowKeys(row: ResultRow): RowKeys {
  return {
    pj: reportPj(row.cells[PJ_COL] ?? ""),
    name: nameKey(row.cells[OWNER_COL] ?? ""),
    address: addressKey(row.cells[ADDRESS_COL] ?? ""),
    // 物件名称は現場番号や別の番地を含むので、棟記号の食い違いを弾くのにだけ使う
    unit: unitToken(row.cells[PROPERTY_COL] ?? ""),
  };
}

const NOT_FOUND: CustomerMatch = {
  customer: null,
  confidence: "none",
  reason: "顧客データに見つかりません",
};

/**
 * 報告書1件に対応する顧客を探す。
 *
 * PJ (契約番号) が最も確かだが、助っ人クラウドのPJは管理IDからの変換なので別人と衝突しうる
 * (lib/after/dedup.ts 参照)。そのため氏名・住所で裏取りできたものだけを exact とし、
 * 裏取りできないものは probable にして画面で確認してもらう。
 */
export function matchCustomerForRow(row: ResultRow, index: CustomerIndex): CustomerMatch {
  const keys = rowKeys(row);
  const nameMatches = (k: CustomerKeys) => keys.name !== "" && k.name === keys.name;
  const addressRelation = (k: CustomerKeys) => compareAddress(keys.address, k.address);
  const addressMatches = (k: CustomerKeys) => {
    const rel = addressRelation(k);
    return rel === "same" || rel === "extends";
  };
  // 同じ敷地の別棟 (A号棟 と B号棟) を結び付けないための最後の砦
  const unitConflicts = (k: CustomerKeys) =>
    keys.unit !== "" && k.unit !== "" && keys.unit !== k.unit;

  if (keys.pj) {
    const candidates = (index.byPj.get(keys.pj) ?? []).filter((k) => !unitConflicts(k));
    if (candidates.length === 1) {
      const k = candidates[0];
      if (k.customer.source === "dx") {
        // 点検保守台帳のIDはPJそのものなので、PJの一致で足りる
        if (addressRelation(k) === "conflict" && !nameMatches(k)) {
          return {
            customer: k.customer,
            confidence: "probable",
            reason: "PJは一致しますが氏名・住所が違います",
          };
        }
        return { customer: k.customer, confidence: "exact", reason: "PJが一致 (点検保守台帳)" };
      }
      if (nameMatches(k)) {
        // 同姓同名は珍しくないので、住所がはっきり違うものは自動更新の対象にしない
        if (addressRelation(k) === "conflict") {
          return {
            customer: k.customer,
            confidence: "probable",
            reason: "PJと氏名は一致しますが住所が違います",
          };
        }
        return { customer: k.customer, confidence: "exact", reason: "PJと氏名が一致" };
      }
      if (addressMatches(k)) {
        return { customer: k.customer, confidence: "exact", reason: "PJと住所が一致" };
      }
      return {
        customer: k.customer,
        confidence: "probable",
        reason: "PJのみ一致 (助っ人クラウドのPJは別人と衝突することがあります)",
      };
    }
    if (candidates.length > 1) {
      const byName = candidates.filter(nameMatches);
      if (byName.length === 1) {
        const k = byName[0];
        if (addressRelation(k) === "conflict") {
          return {
            customer: k.customer,
            confidence: "probable",
            reason: "PJと氏名は一致しますが住所が違います",
          };
        }
        return { customer: k.customer, confidence: "exact", reason: "PJと氏名が一致" };
      }
      const byAddress = (byName.length > 0 ? byName : candidates).filter(addressMatches);
      if (byAddress.length === 1) {
        return { customer: byAddress[0].customer, confidence: "exact", reason: "PJと住所が一致" };
      }
      return {
        customer: null,
        confidence: "none",
        reason: `PJが複数の顧客に一致 (${candidates.length}件)`,
        alternatives: candidates.map((k) => k.customer),
      };
    }
  }

  // PJで見つからないとき (助っ人クラウドはPJが空の顧客が多い) は氏名+住所の2つで照合する
  const byName = (index.byName.get(keys.name) ?? []).filter(
    (k) => !unitConflicts(k) && addressMatches(k),
  );
  if (keys.name === "" || byName.length === 0) return NOT_FOUND;
  if (byName.length === 1) {
    return {
      customer: byName[0].customer,
      confidence: "probable",
      reason: "氏名と住所が一致 (PJは未設定または不一致)",
    };
  }
  return {
    customer: null,
    confidence: "none",
    reason: `氏名と住所が複数の顧客に一致 (${byName.length}件)`,
    alternatives: byName.map((k) => k.customer),
  };
}

/** 報告書と顧客データの引渡日を見比べる */
export function handoverDiff(
  row: ResultRow,
  customer: Customer,
): { reportDate: string | null; customerDate: string | null; status: "update" | "same" | "invalid" } {
  const reportDate = normalizeHandoverDate(row.cells[HANDOVER_COL] ?? "").date;
  const customerDate = effectiveFields(customer).handoverDate ?? null;
  if (!reportDate) return { reportDate: null, customerDate, status: "invalid" };
  return {
    reportDate,
    customerDate,
    status: reportDate === customerDate ? "same" : "update",
  };
}

/**
 * 処理できた行それぞれについて、顧客データの引渡日をどうするかを組み立てる。
 *
 * まとめて更新 (自動反映) の対象は「照合が確実」で「報告書の引渡日が要確認でない」もの。
 * 顧客データ側で手直しした引渡日は勝手に上書きしない (行ごとのボタンでは更新できる)。
 */
export function buildHandoverSync(
  rows: readonly ResultRow[],
  customers: readonly Customer[],
): HandoverSyncItem[] {
  const index = indexCustomers(customers);
  return rows
    .filter((row) => !row.error)
    .map((row) => {
      const match = matchCustomerForRow(row, index);
      const pj = reportPj(row.cells[PJ_COL] ?? "");
      const ownerDisplay = row.cells[OWNER_COL] || row.ownerDisplay;
      if (!match.customer) {
        return {
          pairId: row.pairId,
          ownerDisplay,
          pj,
          reportDate: normalizeHandoverDate(row.cells[HANDOVER_COL] ?? "").date,
          customerDate: null,
          match,
          status: match.alternatives?.length ? ("ambiguous" as const) : ("unmatched" as const),
          autoApplicable: false,
        };
      }

      const diff = handoverDiff(row, match.customer);
      const manualEdit =
        "handoverDate" in match.customer.edits && !isReportHandover(match.customer);
      const uncertainDate = row.confidences[HANDOVER_COL] === "warn";
      let holdReason: string | undefined;
      if (diff.status === "update") {
        if (match.confidence !== "exact") holdReason = "照合が確実ではありません";
        else if (uncertainDate) holdReason = "報告書の引渡日が要確認です";
        else if (manualEdit) holdReason = "顧客データ側で手直し済みです";
      }
      return {
        pairId: row.pairId,
        ownerDisplay,
        pj,
        reportDate: diff.reportDate,
        customerDate: diff.customerDate,
        match,
        status: diff.status,
        autoApplicable: diff.status === "update" && holdReason === undefined,
        holdReason,
      };
    });
}
