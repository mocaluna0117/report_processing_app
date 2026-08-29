"use client";

// 受付メモの要約 (アフターメンテナンス)。
// 送る前に、選んでいる顧客の氏名・カナ・電話番号・住所・メールを伏せ字にする。
// 顧客レコードが手元にあるので、サーバー側の推定 (redactPii) に頼らず確実に消せる。
import { effectiveFields } from "@/lib/after/customer";
import type { Customer } from "@/lib/after/types";
import { INQUIRY_TEXT_MAX, ruleBasedInquirySummary } from "@/lib/summarize/inquiry";
import type { SummarizeResponse } from "@/lib/summarize/types";
import { toHalfWidthAlnum } from "@/lib/text";

export interface InquirySummary {
  summary: string;
  engine: "gemini" | "rule";
  /** 画面に出す注意 (要約が取れなかった・APIに繋がらなかった など) */
  warning?: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 顧客に紐づく個人情報を伏せ字にする (氏名は姓・名それぞれでも消す) */
export function redactCustomer(text: string, customer: Customer): string {
  const fields = effectiveFields(customer);
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

/**
 * 受付メモを要約する。
 * 通信できないときはブラウザ内のルールベースに落として、受付の登録自体は止めない。
 */
export async function summarizeInquiry(
  text: string,
  customer: Customer,
): Promise<InquirySummary> {
  const trimmed = text.trim().slice(0, INQUIRY_TEXT_MAX);
  if (!trimmed) return { summary: "", engine: "rule", warning: "受付内容が空です" };
  const redacted = redactCustomer(trimmed, customer);

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
    };
  } catch (e) {
    return {
      summary: toHalfWidthAlnum(ruleBasedInquirySummary(redacted)),
      engine: "rule",
      warning: `要約を取得できませんでした (${e instanceof Error ? e.message : String(e)})。アフター受付内容を確認してください`,
    };
  }
}
