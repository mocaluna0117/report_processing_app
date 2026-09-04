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
 * input = 伏せ字済みの入力 (受付メモ / 不具合項目)
 * output = 利用者が最終的に書いた本文 (アフター受付内容 / 点検内容)。
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
   * 過去の例 (文体・粒度の手本)。
   * アフターメンテナンスは「受付メモ → アフター受付内容」、
   * 定期点検は「不具合項目 → 点検内容」の組で、画面ごとに別の一覧を持つ。
   * 呼び出し側で伏せ字にしたものだけを送ること (サーバー側でも redactPii を掛ける)。
   */
  examples?: InquiryExampleInput[];
}

export interface SummarizeResponse {
  summary: string;
  engine: "gemini" | "rule";
  error?: string;
}
