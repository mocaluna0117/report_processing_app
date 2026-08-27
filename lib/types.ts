export type Confidence = "ok" | "warn" | "fail";

export interface FieldValue {
  value: string;
  confidence: Confidence;
  warnings: string[];
}

/** 不具合項目の状況 1ブロック分 */
export interface DefectBlock {
  page: number;
  slot: number;
  location: string; // 場所 (例: 1階 洋室)
  part: string; // 部位 (例: クロス 壁)
  symptom: string; // 症状
  response: string; // 対応
  tempFeel: string; // 温度感
  followup: string; // 事後対応
  remarks: string; // 備考 (継続ブロック結合済み)
}

/** 写真報告書から抽出した構造化データ */
export interface PhotoReportData {
  pj: FieldValue; // 契約番号
  inspectionTiming: FieldValue; // 点検時期 (受付種別)
  developer: FieldValue; // 現場名の【】内
  propertyName: FieldValue; // 現場名の【】以降
  ownerName: FieldValue; // 施主名
  address: FieldValue;
  handoverDate: FieldValue; // 引渡日 YYYY/MM/DD
  inspectionDate: FieldValue; // 点検日 (出力列ではなく整合チェック用)
  defects: DefectBlock[];
  standaloneNotes: string[]; // 直前ブロックの無い備考のみブロック (単独メモ)
  specialNotes: string[]; // 【特記事項】
  noAbnormalityOnPage1: boolean; // 1ページ目に「異常なし」表記あり
  templateRecognized: boolean;
}

/** PDFテキスト層の1アイテム。y はページ上端原点のベースライン位置 (pt) */
export interface TextToken {
  str: string;
  x: number;
  y: number;
  page: number; // 1始まり
}

/** 工事区分1件分 (点検報告書で「有」に丸が付いた項目)。confidence=warn は画像認識が自信なし */
export interface WorkCategoryEntry {
  value: string;
  confidence: Confidence;
  /** 画像認識が読み取った元の項目名 (参考) */
  item?: string;
}

/**
 * 点検報告書から抽出した連絡先。
 * 電話番号はブラウザ内でのみ保持し (メール文の組み立て用)、/api へは送らない。
 * confidence=warn はハイフン無しの数字列から区切りを推定したもの。
 */
export interface Contact {
  phone: string;
  /** 続柄 (ご主人 / 奥様 / その他 など)。無ければ空 */
  relation: string;
  confidence: Confidence;
}
