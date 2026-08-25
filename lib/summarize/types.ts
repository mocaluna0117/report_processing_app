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
}

export interface SummarizeResponse {
  summary: string;
  engine: "gemini" | "rule";
  error?: string;
}
