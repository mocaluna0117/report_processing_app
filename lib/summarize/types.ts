/** 要約APIへ送る不具合1件分 (施主名・住所・契約番号は含めない) */
export interface DefectForSummary {
  location: string;
  part: string;
  symptom: string;
  followup: string;
  remarks: string;
}

/**
 * 学習した書き方1件のうち、要約APIへ送る部分。
 * input = 伏せ字済みの受付メモ / output = 利用者が最終的に書いた「アフター受付内容」。
 */
export interface InquiryExampleInput {
  input: string;
  output: string;
}

export interface SummarizeRequest {
  defects: DefectForSummary[];
  standaloneNotes: string[];
  specialNotes: string[];
  noAbnormality: boolean;
  /**
   * アフターメンテナンス: コールセンターの受付メモ (自由文)。
   * これがある場合は defects ではなくこちらから要約する。
   * 呼び出し側で顧客の氏名・電話・住所を伏せてから送ること。
   */
  inquiryText?: string;
  /**
   * アフターメンテナンス: 過去の受付例 (文体・粒度の手本)。inquiryText があるときだけ使う。
   * 呼び出し側で伏せ字にしたものだけを送ること (サーバー側でも redactPii を掛ける)。
   */
  examples?: InquiryExampleInput[];
}

export interface SummarizeResponse {
  summary: string;
  engine: "gemini" | "rule";
  error?: string;
}
