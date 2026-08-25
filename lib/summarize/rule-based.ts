import type { SummarizeRequest } from "./types";

function firstSentence(text: string, max = 45): string {
  const s = text.split(/[。\n]/)[0]?.trim() ?? "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function truncate(text: string, max: number): string {
  const s = text.trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * LLMを使わない定型要約 (Geminiキー未設定時・API失敗時のフォールバック)。
 * 外部送信ゼロで決定的に動く。
 */
export function ruleBasedSummary(req: SummarizeRequest): string {
  const parts: string[] = [];

  if (req.defects.length === 0) {
    parts.push("点検の結果、不具合の指摘なし。");
  } else {
    const items = req.defects.map((d) => {
      const place = [d.location, d.part].filter(Boolean).join(" ");
      // 症状が「その他（備考）」の場合は備考の先頭文の方が内容を表す
      const symptom =
        d.symptom && !/その他/.test(d.symptom)
          ? d.symptom
          : firstSentence(d.remarks) || d.symptom;
      const tail = d.followup ? `（${d.followup}）` : "";
      return `${place ? `${place}の` : ""}${symptom}${tail}`;
    });
    parts.push(`${items.join("、")}。`);
  }

  for (const n of req.specialNotes) parts.push(`特記事項: ${truncate(n, 80)}`);
  for (const n of req.standaloneNotes) parts.push(`メモ: ${truncate(n, 80)}`);

  return parts.join(" ");
}
