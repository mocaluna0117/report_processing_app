"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { downloadBytes } from "@/lib/download";
import type { ResultRow } from "@/lib/process";
import { loadReportAssets, resolveReportFonts } from "@/lib/report/assets";
import {
  canQueryLocalFonts,
  clearLocalFonts,
  loadLocalFontInfo,
  registerFromFiles,
  registerFromLocalFonts,
  type LocalFontInfo,
} from "@/lib/report/fonts";
import {
  APPENDIX_THRESHOLD,
  REPORT_PDF_NAME,
  REPORT_XLSX_NAME,
  buildReportData,
  type ReportOptions,
} from "@/lib/report/model";

/**
 * 完了報告書 (xlsx / PDF) の内容確認とダウンロード。
 * 値は結果テーブルの現在値から毎回組み立てるので、テーブルを直すとここにも反映される。
 * 生成はすべてブラウザ内で行い、個人情報をサーバーへ送ることはない。
 */
const ATTENDANCE_LABELS: { key: keyof ReportOptions["attendance"]; label: string }[] = [
  { key: "owner", label: "施主" },
  { key: "family", label: "施主ご家族" },
  { key: "other", label: "その他" },
];
const CATEGORY_LABELS: { key: keyof ReportOptions["categories"]; label: string }[] = [
  { key: "inspection", label: "点検" },
  { key: "after", label: "アフター" },
  { key: "paid", label: "有償工事" },
  { key: "direct", label: "直収対応" },
  { key: "free", label: "無償対応" },
];

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function ReportDialog({
  row,
  onOptionsChange,
  onKanaChange,
  onClose,
}: {
  row: ResultRow;
  onOptionsChange: (pairId: string, options: ReportOptions) => void;
  onKanaChange: (pairId: string, kana: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<"xlsx" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** PDF作成時の注意 (フォントに無い文字・枠に収まらない欄)。エラーとは分けて残す */
  const [notices, setNotices] = useState<string[]>([]);
  const [done, setDone] = useState<"xlsx" | "pdf" | null>(null);
  /** PDFに使う書体 (未登録なら同梱の Noto Sans JP) */
  const [fontInfo, setFontInfo] = useState<LocalFontInfo | null>(null);
  const [fontBusy, setFontBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadLocalFontInfo()
      .then(setFontInfo)
      .catch(() => setFontInfo(null));
  }, []);

  // Escで閉じられるようにする (他のダイアログと同じ操作感)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const data = useMemo(() => buildReportData(row, row.report), [row]);

  const toggle = (group: "attendance" | "categories", key: string, checked: boolean) => {
    onOptionsChange(row.pairId, {
      ...row.report,
      [group]: { ...row.report[group], [key]: checked },
    });
  };

  const run = async (kind: "xlsx" | "pdf") => {
    setBusy(kind);
    setError(null);
    setDone(null);
    if (kind === "pdf") setNotices([]);
    try {
      const assets = await loadReportAssets();
      if (kind === "xlsx") {
        const { buildReportXlsx } = await import("@/lib/report/xlsx");
        downloadBytes(buildReportXlsx(assets.template, data), REPORT_XLSX_NAME, XLSX_MIME);
      } else {
        const { buildReportPdf } = await import("@/lib/report/pdf");
        const { fonts } = await resolveReportFonts();
        const { bytes, warnings } = await buildReportPdf(data, fonts);
        downloadBytes(bytes, REPORT_PDF_NAME, "application/pdf");
        setNotices(warnings);
      }
      setDone(kind);
      setTimeout(() => setDone(null), 2500);
    } catch (e) {
      setError(`${kind === "xlsx" ? "Excel" : "PDF"}の作成に失敗しました (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setBusy(null);
    }
  };

  const registerFonts = async (action: () => Promise<LocalFontInfo | null>) => {
    setFontBusy(true);
    setError(null);
    try {
      const info = await action();
      if (info) setFontInfo(info);
      else setError("游ゴシックが見つかりませんでした。フォントファイルを選んで登録してください");
    } catch (e) {
      setError(`フォントを登録できませんでした (${e instanceof Error ? e.message : String(e)})`);
    } finally {
      setFontBusy(false);
    }
  };

  const fields: [string, string][] = [
    ["PJコード", data.pj],
    ["引渡日", data.handoverDate],
    ["物件名", data.propertyName],
    ["施主名", data.ownerLine ? `${data.ownerLine} 様` : ""],
    ["住所", data.address],
    ["連絡先①", data.phone1],
    ["連絡先②", data.phone2],
    ["受付日", data.receptionDate],
    ["受付者", data.receptionist],
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`完了報告書 ${row.ownerDisplay}`}
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold">完了報告書 — {row.ownerDisplay}</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              内容は結果テーブルの現在値から作られます。作業内容・是正内容以降は空欄のままです
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50"
          >
            閉じる
          </button>
        </div>

        <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
          {fields.map(([label, value]) => (
            <div key={label} className="col-span-2 grid grid-cols-subgrid items-baseline">
              <dt className="text-slate-500">{label}</dt>
              <dd className={value ? "" : "text-slate-400"}>{value || "(空欄)"}</dd>
            </div>
          ))}
        </dl>

        <label className="mt-4 block text-sm">
          <span className="font-medium">施主名のカナ</span>
          <span className="ml-2 text-xs text-slate-500">
            空欄なら括弧ごと省いて出力します（メール文と共通です）
          </span>
          <input
            value={row.mail.ownerKana}
            onChange={(e) => onKanaChange(row.pairId, e.target.value)}
            placeholder="ヤマダ　タロウ"
            className={`mt-1 w-full rounded border px-2 py-1.5 text-sm ${
              row.mail.ownerKana ? "border-slate-300 bg-white" : "border-amber-300 bg-amber-50"
            }`}
          />
        </label>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(
            [
              ["立会", "attendance", ATTENDANCE_LABELS],
              ["受付項目", "categories", CATEGORY_LABELS],
            ] as const
          ).map(([title, group, labels]) => (
            <fieldset key={group} className="rounded-lg border border-slate-200 p-3">
              <legend className="px-1 text-xs font-medium text-slate-500">{title}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {labels.map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(
                        (row.report[group] as unknown as Record<string, boolean>)[key],
                      )}
                      onChange={(e) => toggle(group, key, e.target.checked)}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>

        <div className="mt-4">
          <p className="text-sm font-medium">
            指示内容 <span className="text-xs font-normal text-slate-500">（アフター受付内容から）</span>
          </p>
          {data.items.length === 0 ? (
            <p className="mt-1 text-sm text-amber-800">
              指示内容が空です。アフター受付内容を入力してから作成してください
            </p>
          ) : (
            <ol className="mt-1 list-decimal space-y-0.5 pl-6 text-sm">
              {data.items.map((item, i) => (
                <li key={`${i}-${item}`}>{item}</li>
              ))}
            </ol>
          )}
          {data.useAppendix && (
            <p className="mt-2 rounded bg-blue-50 px-2 py-1.5 text-xs text-blue-900">
              {APPENDIX_THRESHOLD}件以上あるので、本紙の指示内容は「別紙参照」にして、全{data.items.length}件を別紙に記載します
            </p>
          )}
          {data.warnings.map((w) => (
            <p key={w} className="mt-2 text-xs text-amber-800">
              {w}
            </p>
          ))}
        </div>

        <div className="mt-4 rounded-lg border border-slate-200 p-3 text-sm">
          <p className="text-xs font-medium text-slate-500">PDFの書体</p>
          <p className="mt-1">
            {fontInfo ? (
              <>
                <span className="font-medium">{fontInfo.family}</span>
                <span className="ml-2 text-xs text-slate-500">
                  この端末に登録済み ({fontInfo.regularName} / {fontInfo.boldName},{" "}
                  {(fontInfo.bytes / 1024 / 1024).toFixed(1)}MB)
                </span>
              </>
            ) : (
              <>
                <span className="font-medium">Noto Sans JP</span>
                <span className="ml-2 text-xs text-slate-500">
                  同梱の代替書体。見本と同じ游ゴシックにするには、この端末のフォントを登録してください
                </span>
              </>
            )}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {canQueryLocalFonts() && (
              <button
                type="button"
                disabled={fontBusy}
                onClick={() => registerFonts(() => registerFromLocalFonts())}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                {fontBusy ? "登録中…" : "端末の游ゴシックを使う"}
              </button>
            )}
            <button
              type="button"
              disabled={fontBusy}
              onClick={() => fontInputRef.current?.click()}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-50"
            >
              フォントファイルを選ぶ…
            </button>
            {fontInfo && (
              <button
                type="button"
                disabled={fontBusy}
                onClick={() =>
                  registerFonts(async () => {
                    await clearLocalFonts();
                    setFontInfo(null);
                    return null;
                  }).then(() => setError(null))
                }
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                同梱の書体に戻す
              </button>
            )}
            <input
              ref={fontInputRef}
              type="file"
              accept=".ttc,.ttf,.otf,font/ttf,font/otf"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length > 0) void registerFonts(() => registerFromFiles(files));
              }}
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            游ゴシックは Windows / Microsoft Office に付属する書体で、再配布はできませんが、
            ライセンスを持つ端末で自分の文書に埋め込むことは許可されています
            (フォント側の埋め込み設定も許可)。登録したフォントはこの端末の中だけに保存され、外部へは送信されません。
            Mac は <code>/Applications/Microsoft Word.app/Contents/Resources/DFonts/YuGothR.ttc</code> と{" "}
            <code>YuGothB.ttc</code>、Windows は <code>C:\Windows\Fonts\</code> の同名ファイルです
          </p>
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded bg-red-50 px-2 py-1.5 text-xs text-red-900">
            {error}
          </p>
        )}
        {notices.map((notice) => (
          <p key={notice} className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
            作成したPDFについて: {notice}
          </p>
        ))}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <span className="mr-auto text-xs text-slate-500">
            保存名: {REPORT_XLSX_NAME} ／ {REPORT_PDF_NAME}
          </span>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run("xlsx")}
            className="rounded-lg border border-emerald-600 bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy === "xlsx" ? "作成中…" : done === "xlsx" ? "保存しました ✓" : "Excelをダウンロード"}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run("pdf")}
            className="rounded-lg border border-slate-800 bg-slate-800 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-900 disabled:opacity-50"
          >
            {busy === "pdf" ? "作成中…" : done === "pdf" ? "保存しました ✓" : "PDFをダウンロード"}
          </button>
        </div>
      </div>
    </div>
  );
}
