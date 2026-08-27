import { circledNumber } from "@/lib/summarize/format";
import { toDateZeroPad, toFullWidthSpace } from "@/lib/text";
import type { Contact } from "@/lib/types";

/**
 * メール本文に貼るテキストの組み立て。
 * すべてブラウザ内で行い、電話番号などを /api へ送ることはない。
 */
export interface MailInput {
  /** 引渡日のセル値 (ゼロ埋めなし)。メールでは yyyy/mm/dd にゼロ埋めする */
  handoverDate: string;
  propertyName: string;
  /** 施主名 (漢字)。姓名間の空白は全角に揃える */
  ownerName: string;
  /** カタカナ読み。空なら括弧ごと省略する */
  ownerKana: string;
  address: string;
  contacts: Contact[];
  /** アフター受付内容 (①②で改行された要約) */
  summary: string;
}

function contactLines(contacts: Contact[]): string[] {
  if (contacts.length === 0) return ["連絡先："];
  if (contacts.length === 1) return [`連絡先：${contacts[0].phone}`];
  return contacts.map(
    (c, i) =>
      `連絡先${circledNumber(i + 1)}：${c.phone}${c.relation ? `（${c.relation}）` : ""}`,
  );
}

export function buildMailText(input: MailInput): string {
  const owner = toFullWidthSpace(input.ownerName.trim());
  const kana = toFullWidthSpace(input.ownerKana.trim());
  const ownerLine = owner ? `${owner}${kana ? `（${kana}）` : ""}様` : "";

  return [
    "【物件情報】",
    `引渡日：${toDateZeroPad(input.handoverDate.trim())}`,
    `物件名：${input.propertyName.trim()}`,
    `施主名：${ownerLine}`,
    `住所：${input.address.trim()}`,
    ...contactLines(input.contacts),
    "",
    "【依頼内容】",
    input.summary.trim(),
  ].join("\n");
}
