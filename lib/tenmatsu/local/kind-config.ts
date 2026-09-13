/**
 * ブラウザ側で記録とフォルダーを扱うときの、書類の種類ごとの設定。
 *
 * 移植元: tenmatsu-dl/config.json（kinds.*）と tenmatsu.py 174-223, 309-385
 *
 * ★楽楽精算の画面の設定（列・ラベル）は `lib/rakuraku/kinds.ts` の1か所から作る。
 *   記録に残す項目を二重に書くと、片方だけ直したときに**値が黙って捨てられる**（移植元で起きた形）。
 */
import { KINDS, type KindId } from "@/lib/rakuraku/kinds";
import type { FlagKey } from "@/lib/tenmatsu/client";

/** 記録の置き場（選んだフォルダーの中） */
export const RECORDS_DIR = "_記録";
/** 添付を結合できなかった伝票・あとから書類を入れる伝票の置き場。★正式なフォルダーには入れない */
export const PENDING_DIR = "_保留";
/** 確定したあとも部品を残す置き場（捺印決裁書。差し替えて組み直すため） */
export const PARTS_DIR = "_部品";
/** 保留・部品のフォルダーの中の「ファイルの並び」 */
export const MANIFEST_NAME = "manifest.json";
/** 保留中のPDF（本体＋結合できた添付） */
export const PENDING_MERGED_NAME = "_merged.pdf";

/** 1回に取る件数。★範囲外は丸めずに断る */
export const RUN_LIMITS = { value: 10, min: 1, max: 100 } as const;

/**
 * 種類によらず記録に残す項目。
 *   skipped_attachments  … 動画・音声なので結合せずに飛ばした添付の名前
 *   missing_attachments  … 添付が欠けたまま確定したときの、欠けた添付
 *   replaced_attachments … あとから入れて補った添付の名前
 *   final_name           … 確定したときに付ける名前（捺印決裁書）
 *   linked_attachments   … 紐づく伝票（専決決裁書）に付いていた添付の名前ぜんぶ。
 *                          ★名前の決め方を直したときに、楽楽精算を開き直さずに付け直せるように残す
 *   recomposed_at        … 差し替えて組み直した日時
 */
export const EXTRA_META_KEYS = [
  "skipped_attachments",
  "missing_attachments",
  "replaced_attachments",
  "final_name",
  "linked_attachments",
  "recomposed_at",
] as const;

export interface LocalKindConfig {
  id: KindId;
  label: string;
  /** `_記録/` の中の記録のファイル名（移植元と同じ名前） */
  processedFile: string;
  filePrefix: string;
  /** 完了の印 */
  flagKeys: readonly FlagKey[];
  /** 確定したあとも部品を残すか（捺印決裁書） */
  keepParts: boolean;
  /**
   * 記録に残す項目の全部（この順で記録に書く）。
   * ★ここに無い項目は、渡しても**黙って捨てられる**。項目を増やすときは kinds.ts に足す。
   */
  metaKeys: readonly string[];
  /** 紐づく伝票から組み立てる種類か（捺印決裁書） */
  composed: boolean;
}

const PROCESSED_FILES: Record<KindId, string> = {
  tenmatsu: "processed.json",
  senketsu: "processed_senketsu.json",
  natsuin: "processed_natsuin.json",
};

/** 完了の印。★顛末書だけ実行予算の入力がある（専決決裁書・捺印決裁書はクラウド格納だけ） */
const FLAG_KEYS: Record<KindId, readonly FlagKey[]> = {
  tenmatsu: ["budget_entered", "cloud_stored"],
  senketsu: ["cloud_stored"],
  natsuin: ["cloud_stored"],
};

function build(id: KindId): LocalKindConfig {
  const kind = KINDS[id];
  const listKeys = Object.keys(kind.list.columns);
  const detailKeys = [...Object.keys(kind.detail.labels), "final_approved_at"];
  const linked = kind.compose?.copyFromLinked ?? [];
  return {
    id,
    label: kind.label,
    processedFile: PROCESSED_FILES[id],
    filePrefix: kind.filePrefix,
    flagKeys: FLAG_KEYS[id],
    keepParts: kind.keepParts,
    metaKeys: [...new Set([...listKeys, ...detailKeys, ...linked, ...EXTRA_META_KEYS])],
    composed: kind.compose !== undefined,
  };
}

export const LOCAL_KINDS: Readonly<Record<KindId, LocalKindConfig>> = {
  tenmatsu: build("tenmatsu"),
  senketsu: build("senketsu"),
  natsuin: build("natsuin"),
};
