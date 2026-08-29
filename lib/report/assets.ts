"use client";

// 完了報告書のテンプレート (xlsx) と日本語フォントをブラウザに読み込む。
// どちらも public/ に置いた静的ファイルで、取得後はメモリに残して使い回す
// (フォントは約1.5MBあるので毎回取り直さない)。
import { gunzipSync } from "fflate";
import {
  REPORT_FONT_BOLD_URL,
  REPORT_FONT_REGULAR_URL,
  REPORT_TEMPLATE_URL,
} from "@/lib/report/asset-names.generated";
import { loadLocalFontInfo, loadLocalFonts, type LocalFontInfo } from "@/lib/report/fonts";
import type { ReportFonts } from "@/lib/report/pdf";

export interface ReportAssets {
  template: Uint8Array;
  fonts: ReportFonts;
}

let cache: Promise<ReportAssets> | null = null;

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error(`${url} の取得に失敗しました (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchGzipped(url: string): Promise<Uint8Array> {
  const raw = await fetchBytes(url);
  // gzip (1f 8b) で置いてある。取り違えに気付けるよう先頭を確認する
  if (raw[0] !== 0x1f || raw[1] !== 0x8b) throw new Error(`${url} がgzipではありません`);
  return gunzipSync(raw);
}

async function load(): Promise<ReportAssets> {
  const [template, regular, bold] = await Promise.all([
    fetchBytes(REPORT_TEMPLATE_URL),
    fetchGzipped(REPORT_FONT_REGULAR_URL),
    fetchGzipped(REPORT_FONT_BOLD_URL),
  ]);
  if (template[0] !== 0x50 || template[1] !== 0x4b) {
    throw new Error("完了報告書のテンプレート (xlsx) を読めませんでした");
  }
  return { template, fonts: { regular, bold } };
}

/** テンプレートとフォントを取得する (2回目以降はキャッシュ。失敗したら次回やり直す) */
export function loadReportAssets(): Promise<ReportAssets> {
  if (!cache) {
    cache = load().catch((e) => {
      cache = null;
      throw e;
    });
  }
  return cache;
}

export interface ResolvedReportFonts {
  fonts: ReportFonts;
  /** local: 端末に登録された書体 (游ゴシック等) / bundled: 同梱の Noto Sans JP */
  source: "local" | "bundled";
  info: LocalFontInfo | null;
}

/**
 * PDFに使うフォントを決める。端末のフォントが登録されていればそれを、
 * 無ければ同梱の Noto Sans JP を返す。
 */
export async function resolveReportFonts(): Promise<ResolvedReportFonts> {
  const [local, info] = await Promise.all([
    loadLocalFonts().catch(() => null),
    loadLocalFontInfo().catch(() => null),
  ]);
  if (local && info) {
    return {
      fonts: {
        regular: local.regular,
        bold: local.bold,
        regularFaceIndex: local.regularFaceIndex,
        boldFaceIndex: local.boldFaceIndex,
      },
      source: "local",
      info,
    };
  }
  const assets = await loadReportAssets();
  return { fonts: assets.fonts, source: "bundled", info: null };
}

/** ボタンにカーソルを乗せた時などに先読みする (失敗は無視) */
export function prefetchReportAssets(): void {
  void loadReportAssets().catch(() => {});
}
