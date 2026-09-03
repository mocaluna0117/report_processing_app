"use client";

// 受付メモの要約 (アフターメンテナンス)。
// 送る前に、選んでいる顧客の氏名・カナ・電話番号・住所・メールを伏せ字にする。
// 顧客レコードが手元にあるので、サーバー側の推定 (redactPii) に頼らず確実に消せる。
import { effectiveFields } from "@/lib/after/customer";
import type { AfterCase, Customer, CustomerFields } from "@/lib/after/types";
import {
  EXAMPLE_INPUT_MAX,
  EXAMPLE_OUTPUT_MAX,
  type InquiryExample,
  selectInquiryExamples,
} from "@/lib/summarize/examples";
import { INQUIRY_TEXT_MAX, ruleBasedInquirySummary } from "@/lib/summarize/inquiry";
import { redactPii } from "@/lib/summarize/redact";
import type { InquiryExampleInput } from "@/lib/summarize/types";
import type { SummarizeResponse } from "@/lib/summarize/types";
import { recordSummary } from "@/lib/summary";
import { toHalfWidthAlnum } from "@/lib/text";
import { ADDRESS_COL, OWNER_COL } from "@/lib/tsv";

export interface InquirySummary {
  summary: string;
  engine: "gemini" | "rule";
  /** 画面に出す注意 (要約が取れなかった・APIに繋がらなかった など) */
  warning?: string;
  /** 要約APIへ送った伏せ字済みの受付メモ (学習用に受付へ残す) */
  redacted: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 伏せ字に使う顧客の項目 (顧客レコードでも受付の行でも作れるようにしている) */
type RedactSource = Pick<
  CustomerFields,
  "ownerName" | "ownerKana" | "address" | "contacts" | "emails"
>;

/** 手元の値で個人情報を伏せ字にする (氏名は姓・名それぞれでも消す) */
export function redactFields(text: string, fields: RedactSource): string {
  const names = [fields.ownerName, fields.ownerKana].flatMap((name) => {
    const trimmed = name.trim();
    if (!trimmed) return [];
    // 「山田　太郎」「山田」「太郎」のどれで書かれていても消す
    return [trimmed, ...trimmed.split(/[\s　]+/)].filter((part) => part.length >= 2);
  });
  const phones = fields.contacts.flatMap((c) => [c.phone, c.phone.replace(/-/g, "")]);
  const addresses = fields.address ? [fields.address] : [];

  let out = text;
  for (const [values, mark] of [
    [names, "（お客様）"],
    [phones, "（電話番号）"],
    [addresses, "（住所）"],
    [fields.emails, "（メール）"],
  ] as const) {
    for (const value of [...new Set(values)].sort((a, b) => b.length - a.length)) {
      if (!value) continue;
      out = out.replace(new RegExp(escapeRegExp(value), "g"), mark);
    }
  }
  return out;
}

/** 顧客に紐づく個人情報を伏せ字にする */
export function redactCustomer(text: string, customer: Customer): string {
  return redactFields(text, effectiveFields(customer));
}

/**
 * 受付の行だけを手がかりに伏せ字にする (顧客データを消したあとでも学習できるように)。
 * 値は結果テーブルで直したあとのものを使う。
 */
export function redactFromCase(row: AfterCase): string {
  return redactFields(row.inquiryText, {
    ownerName: row.cells[OWNER_COL] ?? "",
    ownerKana: row.mail.ownerKana,
    address: row.cells[ADDRESS_COL] ?? "",
    contacts: row.mail.contacts,
    emails: [],
  });
}

/** 保存済みの伏せ字メモがあればそれを使い、無ければ (古い受付) 行から作る */
export function redactedInquiryOf(row: AfterCase): string {
  return row.redactedInquiry ?? redactFromCase(row);
}

/**
 * 学習する1件分 (受付メモ → 利用者が書いた本文) を組み立てる。
 *
 * どちらも伏せ字にしてから返す。本文は利用者が手で書くところなので、
 * お客様の名前や電話番号が混ざりうる (保存も送信も伏せ字だけにする)。
 * 本文は工事区分ごとに分けている場合もあるため、記録単位にまとめたものを使う。
 */
export function inquiryExampleOf(row: AfterCase): InquiryExampleInput {
  return {
    input: redactPii(redactedInquiryOf(row)).trim().slice(0, EXAMPLE_INPUT_MAX),
    output: redactPii(recordSummary(row)).trim().slice(0, EXAMPLE_OUTPUT_MAX),
  };
}

/**
 * 受付メモを要約する。
 * 通信できないときはブラウザ内のルールベースに落として、受付の登録自体は止めない。
 */
export async function summarizeInquiry(
  text: string,
  customer: Customer,
  options: { examples?: readonly InquiryExample[] } = {},
): Promise<InquirySummary> {
  const trimmed = text.trim().slice(0, INQUIRY_TEXT_MAX);
  if (!trimmed) return { summary: "", engine: "rule", warning: "受付内容が空です", redacted: "" };
  const redacted = redactCustomer(trimmed, customer);
  // 学習した書き方のうち、今回のメモに近いものを手本として添える
  const examples = selectInquiryExamples(redacted, options.examples ?? []).map(
    ({ input, output }) => ({ input, output }),
  );

  try {
    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        defects: [],
        standaloneNotes: [],
        specialNotes: [],
        noAbnormality: false,
        inquiryText: redacted,
        examples,
      }),
      // サーバー側の予算(30s)より少し長めに取る
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok) throw new Error(`summarize API ${res.status}`);
    const data = (await res.json()) as SummarizeResponse;
    return {
      summary: toHalfWidthAlnum(data.summary),
      engine: data.engine,
      warning: data.error ? `要約API: ${data.error}` : undefined,
      redacted,
    };
  } catch (e) {
    return {
      summary: toHalfWidthAlnum(ruleBasedInquirySummary(redacted)),
      engine: "rule",
      warning: `要約を取得できませんでした (${e instanceof Error ? e.message : String(e)})。アフター受付内容を確認してください`,
      redacted,
    };
  }
}
