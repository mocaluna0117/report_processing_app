// アフターメンテナンスの受付で選ぶ値 (結果テーブルのプルダウン)。
import { RECEPTIONIST_COL, RECEPTION_TYPE_COL, REMARKS_COL } from "@/lib/tsv";

/** 受付種別 (どこから受け付けたか)。既定は未選択で、行ごとに選んでもらう */
export const RECEPTION_TYPES = [
  "リロ",
  "問合フォーム",
  "TEL",
  "メール",
  "訪問時",
  "営業",
  "保険",
  "工事部",
  "HP",
  "TH",
  "DH",
  "CI",
  "TTS",
  "点検再受付",
  "その他",
  "社長",
  "法務",
] as const;

/** 受付者 (アフターメンテナンス課の担当) */
export const RECEPTIONISTS = [
  "木村",
  "山下",
  "松廣",
  "丸山",
  "岩野",
  "石塚",
  "藤郷",
  "大場",
  "大浦",
] as const;

export const DEFAULT_RECEPTIONIST = "木村";

/** アフターでは備考欄を貼り付けない (定期点検の「点検報告書作成」用の欄のため) */
export const AFTER_HIDDEN_COLUMNS: ReadonlySet<number> = new Set([REMARKS_COL]);

/** プルダウンにする列 */
export const AFTER_SELECT_COLUMNS: Record<
  number,
  { options: readonly string[]; emptyLabel?: string; warnEmpty?: boolean }
> = {
  [RECEPTION_TYPE_COL]: {
    options: RECEPTION_TYPES,
    emptyLabel: "－ 未選択 －",
    warnEmpty: true,
  },
  [RECEPTIONIST_COL]: { options: RECEPTIONISTS },
};
