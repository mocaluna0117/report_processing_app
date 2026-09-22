/**
 * 共有フォルダーに置くデータの種類。純データのみ。
 *
 * ★共有するのは「成熟していくもの」だけ: 顧客データの**手直し**と、**学習した書き方**。
 *   台帳の取り込み値は各自が同じ xlsx を取り込めば再現できるので置かない。
 *   受付一覧（受付メモの原文）・定期点検のPDFと抽出結果・フォント・トークンは置かない。
 * ★ファイル名は固定。Box / SharePoint の禁止文字（" * : < > ? / \ |）を使わない。
 */

export type SharedDatasetId = "customer-edits" | "examples-inquiry" | "examples-inspection";

export interface SharedDataset {
  id: SharedDatasetId;
  /** 共有フォルダーの中のファイル名 */
  file: string;
  /** 封筒に書く種類。**別のデータを取り違えて読まないための目印** */
  kind: string;
  /** この形を読める版。知らない版のファイルは読まず・書かない */
  schemaVersion: number;
  /** 画面とログに出す名前 */
  label: string;
}

export const SHARED_SCHEMA_VERSION = 1;

export const SHARED_DATASETS: Readonly<Record<SharedDatasetId, SharedDataset>> = {
  "customer-edits": {
    id: "customer-edits",
    file: "顧客の手直し.json",
    kind: "folio/customer-edits",
    schemaVersion: SHARED_SCHEMA_VERSION,
    label: "顧客の手直し",
  },
  "examples-inquiry": {
    id: "examples-inquiry",
    file: "学習した書き方_アフター.json",
    kind: "folio/examples-inquiry",
    schemaVersion: SHARED_SCHEMA_VERSION,
    label: "学習した書き方（アフター）",
  },
  "examples-inspection": {
    id: "examples-inspection",
    file: "学習した書き方_定期点検.json",
    kind: "folio/examples-inspection",
    schemaVersion: SHARED_SCHEMA_VERSION,
    label: "学習した書き方（定期点検）",
  },
};

export const SHARED_DATASET_IDS = Object.keys(SHARED_DATASETS) as SharedDatasetId[];

/** 書き換える前の控え（1世代だけ。顛末書の _記録 と同じ流儀） */
export const backupName = (file: string): string => `${file}.bak`;
