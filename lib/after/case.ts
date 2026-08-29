// アフターメンテナンスの受付1件 (結果テーブルの1行) を組み立てる。
import { effectiveFields } from "@/lib/after/customer";
import { DEFAULT_RECEPTIONIST } from "@/lib/after/reception";
import type { AfterCase, Customer } from "@/lib/after/types";
import { buildCells, entry } from "@/lib/cells";
import { formatDateNoPadJst, formatLastUpdatedJst } from "@/lib/jst-date";
import { AFTER_REPORT_OPTIONS } from "@/lib/report/model";
import { toFullWidthSpace } from "@/lib/text";
import type { Confidence } from "@/lib/types";

export interface CreateAfterCaseInput {
  id: string;
  customer: Customer;
  /** コールセンターの受付メモ (貼り付けた原文。ブラウザ内のみ) */
  inquiryText: string;
  /** アフター受付内容 (要約結果) */
  summary: string;
  engine: "gemini" | "rule" | null;
  /** 要約が取れなかった (手入力してもらう) */
  summaryFailed?: boolean;
  warnings?: string[];
  now?: Date;
}

export function createAfterCase(input: CreateAfterCaseInput): AfterCase {
  const now = input.now ?? new Date();
  const fields = effectiveFields(input.customer);
  const warnings = [...(input.warnings ?? [])];

  if (!fields.pj) warnings.push("PJが未設定です (顧客データで確認してください)");
  if (!fields.developer) warnings.push("事業者が未設定です (顧客データで確認してください)");
  if (!fields.handoverDate) {
    warnings.push("顧客データに引渡日が無いため空欄です (メール文では手入力してください)");
  }

  const ownerName = fields.ownerName;
  const { cells, confidences } = buildCells({
    PJ: entry(fields.pj ?? "", fields.pj ? "ok" : "fail"),
    // 受付種別は選択肢から選んでもらう (未選択のうちは要確認)
    受付種別: entry("", "warn"),
    受付日: entry(formatDateNoPadJst(now)),
    受付者: entry(DEFAULT_RECEPTIONIST),
    事業者: entry(fields.developer ?? "", fields.developer ? "ok" : "warn"),
    物件名称: entry(fields.propertyName),
    // 法人名は空白をそのままにする (社名の表記を変えない)
    お客様氏名: entry(
      input.customer.corporate ? ownerName : toFullWidthSpace(ownerName),
      ownerName ? "ok" : "fail",
    ),
    住所: entry(fields.address),
    引渡日: entry(fields.handoverDate ?? "", fields.handoverDate ? "ok" : "warn"),
    アフター受付内容: entry(
      input.summary,
      (input.summaryFailed ? "fail" : input.summary ? "ok" : "warn") as Confidence,
    ),
    最終更新日: entry(formatLastUpdatedJst(now)),
    // 備考欄はアフターでは使わない (貼り付け対象からも外す)
  });

  return {
    kind: "after",
    pairId: input.id,
    customerId: input.customer.id,
    customerSource: input.customer.source,
    inquiryText: input.inquiryText,
    createdAt: now.getTime(),
    ownerDisplay: ownerName || fields.propertyName,
    cells,
    confidences,
    // 工事区分は手動で追加できる (点検報告書が無いので自動判定はしない)
    categories: [],
    categoryEngine: "none",
    report: AFTER_REPORT_OPTIONS,
    mail: {
      ownerKana: fields.ownerKana,
      kanaConfidence: fields.ownerKana ? "ok" : "fail",
      kanaAlternatives: [],
      contacts: fields.contacts,
    },
    warnings,
    engine: input.engine,
    merged: null,
    mergedName: "",
    error: null,
  };
}
