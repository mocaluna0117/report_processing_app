/**
 * 定期点検の不具合項目を、要約プロンプトに載せる文にする。純関数のみ。
 *
 * プロンプト (app/api/summarize/route.ts) と「この書き方を学習」の入力で同じ文を使うため、
 * 整形をここに置く。備考・特記事項は自由記述なので、この中で伏せ字にする。
 */
import { redactPii } from "@/lib/summarize/redact";
import type { SummarizeRequest } from "@/lib/summarize/types";

/**
 * 「## 不具合項目」以降の本文 (見出しは含めない)。
 * 事後対応 (弊社継続対応・見積もり希望など) は対応方針なので渡さない。
 */
export function formatDefectList(
  req: Pick<SummarizeRequest, "defects" | "specialNotes">,
): string {
  const lines: string[] = [];
  if (req.defects.length === 0) lines.push("(不具合の指摘なし)");
  req.defects.forEach((d, i) => {
    lines.push(
      `${i + 1}. 場所: ${d.location || "-"} / 部位: ${d.part || "-"} / 症状: ${d.symptom || "-"}`,
    );
    if (d.remarks) {
      lines.push(`   備考(要望や対応方針は無視し、事象だけ読み取る): ${redactPii(d.remarks)}`);
    }
  });
  if (req.specialNotes.length > 0) {
    lines.push("## 特記事項 (事象だけ読み取り、phenomena に含める)");
    for (const n of req.specialNotes) lines.push(`- ${redactPii(n)}`);
  }
  return lines.join("\n");
}
