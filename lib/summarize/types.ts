/** 要約APIへ送る不具合1件分 (施主名・住所・契約番号は含めない) */
export interface DefectForSummary {
  location: string;
  part: string;
  symptom: string;
  followup: string;
  remarks: string;
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
}

export interface SummarizeResponse {
  summary: string;
  engine: "gemini" | "rule";
  error?: string;
}
