// 写真報告書テンプレート (A4 595x842pt・回転0) の実測座標。
// 見本5件すべてで pdftotext -bbox-layout の座標が完全一致することを確認済み。
// テンプレートのラベル文字列はテキスト層に存在しないため、座標バンド+値パターンで抽出する。
// テンプレートが改版されたら scripts/dump-textcontent.mts でダンプして再計測する。

/** ヘッダ行のベースラインy (1ページ目) */
export const HEADER_ROWS = {
  /** 契約番号 / 現場名 / 引渡日 */
  rowA: 70.95,
  /** 住所 / 点検日 */
  rowB: 98.68,
  /** 施主名 / 点検時期 / 点検員 */
  rowC: 126.4,
} as const;

/** ヘッダ行の許容ずれ (行間は約27.7ptなので±10で重複しない) */
export const HEADER_ROW_TOL = 10;

/** ヘッダ内のx境界 */
export const HEADER_X = {
  pjMax: 200, // 契約番号: x < 200
  siteMin: 200, // 現場名: 200 <= x < 445
  siteMax: 445,
  dateMin: 445, // 引渡日/点検日: x >= 445
  addressMax: 300, // 住所: x < 300
  ownerMax: 200, // 施主名: x < 200
  timingMin: 300, // 点検時期: 300 <= x < 445
  timingMax: 445,
} as const;

/** 不具合ブロック (2ページ目以降)。1ページ=3スロット固定 */
export const SLOT = {
  top: 90.16, // スロット0の上端
  pitch: 234.55, // スロット間隔
  firstLineOffset: 8.24, // スロット上端 → 場所1行目ベースライン
} as const;

/**
 * スロット内フィールドの dyバンド (dy = y - (slotTop + firstLineOffset))。
 * 実測中心値に±8ptの余裕を持たせた上で隣接バンドと重ならない範囲。
 */
export const SLOT_BANDS = {
  locationPart: { min: -16, max: 28 }, // 場所(x<115) / 部位(x>=115)、各2行
  symptom: { min: 30, max: 62 }, // 実測dy≈45.7
  responseTemp: { min: 68, max: 101 }, // 対応(x<120) / 温度感(x>=120)、実測dy≈84.5
  followup: { min: 107, max: 139 }, // 事後対応、実測dy≈123.5
  remarks: { min: 140, max: 226.4 }, // 備考 最大5行 (【特記事項】浮きボックスもここに落ちる)
} as const;

export const SLOT_X = {
  locationMax: 115,
  responseMax: 120,
  /** 左テキスト列の右端 (これより右は写真領域なので無視) */
  textColumnMax: 262,
} as const;

/** 継続マーカー (備考末尾) */
export const CONTINUATION_MARKER = /(次頁|次項|次ページ|次ぺージ)に続く\s*$/;

/** 特記事項ヘッダ */
export const SPECIAL_NOTE_MARKER = /^【特記事項】/;
