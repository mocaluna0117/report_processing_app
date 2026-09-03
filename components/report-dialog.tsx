"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ModalShell } from "@/components/modal-shell";
import { downloadBytes } from "@/lib/download";
import type { ResultRow } from "@/lib/process";
import { setContactPhone } from "@/lib/contacts";
import { categoryItemGroups, isSummarySplit, recordSummary, type SummaryParts } from "@/lib/summary";
import {
  ADDRESS_COL,
  HANDOVER_COL,
  OWNER_COL,
  PJ_COL,
  PROPERTY_COL,
  RECEPTION_DATE_COL,
} from "@/lib/tsv";
import type { Contact } from "@/lib/types";
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
  MAIN_SLOTS,
  REPORT_PDF_NAME,
  REPORT_XLSX_NAME,
  RECEPTIONIST,
  buildReportData,
  joinSummary,
  splitSummary,
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

/** 見出し欄の1項目。onChange で結果テーブル (または行の mail / report) に即時書き戻す */
interface HeaderField {
  label: string;
  value: string;
  placeholder?: string;
  /** 入力欄の下に出す補足 (続柄・空欄時の扱い) */
  hint?: string;
  /** 空欄を注意色にする (カナ。完了報告書では括弧ごと省かれる) */
  warnWhenEmpty?: boolean;
  onChange: (value: string) => void;
  onBlur?: () => void;
}

/** 指示内容の編集単位。工事区分が2件以上なら区分ごと、1件以下なら全体で1つ */
interface EditableGroup {
  /** 書き戻し先の区分の添字。null なら共通のセル (onSummaryChange) */
  catIndex: number | null;
  label: string;
  parts: SummaryParts;
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function ReportDialog({
  row,
  onOptionsChange,
  onKanaChange,
  onCellChange,
  onContactsChange,
  onSummaryChange,
  onCategorySummaryChange,
  onClose,
}: {
  row: ResultRow;
  onOptionsChange: (pairId: string, options: ReportOptions) => void;
  onKanaChange: (pairId: string, kana: string) => void;
  /** 見出し欄 (PJコード・物件名など) の編集。結果テーブルの該当セルに書き戻す */
  onCellChange: (pairId: string, col: number, value: string) => void;
  /** 連絡先①②の編集 (結果テーブルに列が無いので mail.contacts を差し替える) */
  onContactsChange: (pairId: string, contacts: Contact[]) => void;
  /** 指示内容の編集 (工事区分が1件以下)。要約の列 (結果テーブルのセル) に書き戻す */
  onSummaryChange: (pairId: string, summary: string) => void;
  /** 指示内容の編集 (工事区分が2件以上)。その区分の行の点検内容だけに書き戻す */
  onCategorySummaryChange: (pairId: string, index: number, value: string) => void;
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
  /**
   * 連絡先の入力途中の文字列。行には番号だけを整えて書くので、
   * 「（奥様）」を打っている途中の括弧が入力欄から消えないよう、編集中はこちらを表示する。
   */
  const [phoneDraft, setPhoneDraft] = useState<{ index: number; text: string } | null>(null);

  useEffect(() => {
    void loadLocalFontInfo()
      .then(setFontInfo)
      .catch(() => setFontInfo(null));
  }, []);

  // 開いたら閉じるボタンに合わせる (Esc・外側クリックでの終了は ModalShell が受け持つ)
  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  /** 指示内容の取り出し元の列名 (画面によって呼び名が違う) */
  const summaryLabel = row.kind === "after" ? "アフター受付内容" : "点検内容";

  const data = useMemo(() => buildReportData(row, row.report), [row]);
  /** 工事区分が2件以上なら、指示内容は区分ごとのグループに分けて編集する */
  const split = isSummarySplit(row);
  /**
   * 指示内容の編集単位。
   * 分けていれば工事区分ごと、分けていなければ全体で1グループ (見た目は今までと同じ)。
   * 書き戻しはグループ単位なので、そのグループのメモ・定型文は joinSummary で保たれる。
   */
  const groups = useMemo<EditableGroup[]>(
    () =>
      split
        ? categoryItemGroups(row.categories).map((g) => ({
            catIndex: g.catIndex,
            label: g.category || "工事区分 未選択",
            parts: g.parts,
          }))
        : [{ catIndex: null, label: "", parts: splitSummary(recordSummary(row)) }],
    [row, split],
  );
  /**
   * 編集中の項目 (グループごと)。書き戻すときに空欄は落とすので、入力途中の空欄はここで保つ。
   * 行が替わったり工事区分の数が変わったら捨てる (書き戻し先がずれるため)。
   */
  const [draft, setDraft] = useState<string[][] | null>(null);
  useEffect(() => {
    setDraft(null);
    setPhoneDraft(null);
  }, [row.pairId, row.categories.length]);
  const itemsOf = (gi: number) => draft?.[gi] ?? groups[gi].parts.items;
  const editGroupItems = (gi: number, next: string[]) => {
    setDraft(groups.map((_, j) => (j === gi ? next : itemsOf(j))));
    const group = groups[gi];
    const text = joinSummary({ ...group.parts, items: next });
    if (group.catIndex === null) onSummaryChange(row.pairId, text);
    else onCategorySummaryChange(row.pairId, group.catIndex, text);
  };
  const totalItems = groups.reduce((n, _, gi) => n + itemsOf(gi).length, 0);
  /**
   * 報告書の№。工事区分をまたいで通しで振る (buildReportData の並びと同じ)。
   * 入力途中の空欄は報告書に載らないので数に入れず、その行の№は空にする
   * (数に入れると後続の工事区分の番号まで実際の報告書とずれる)。
   */
  const numberLabel = (n: number | null) =>
    n === null ? "" : data.useAppendix ? `別紙 ${n}` : n <= MAIN_SLOTS ? `本紙 ${n}` : `${n}`;

  const toggle = (group: "attendance" | "categories", key: string, checked: boolean) => {
    onOptionsChange(row.pairId, {
      ...row.report,
      [group]: { ...row.report[group], [key]: checked },
    });
  };

  /** 受付者。空欄はキーごと外して既定 (RECEPTIONIST) に戻す */
  const setReceptionist = (value: string) => {
    const next: ReportOptions = { ...row.report };
    if (value) next.receptionist = value;
    else delete next.receptionist;
    onOptionsChange(row.pairId, next);
  };

  const cellField = (label: string, col: number, placeholder?: string): HeaderField => ({
    label,
    value: row.cells[col] ?? "",
    placeholder,
    onChange: (value) => onCellChange(row.pairId, col, value),
  });
  const phoneField = (index: 0 | 1): HeaderField => {
    const contact = row.mail.contacts[index];
    return {
      label: `連絡先${index === 0 ? "①" : "②"}`,
      value: phoneDraft?.index === index ? phoneDraft.text : (contact?.phone ?? ""),
      placeholder: "090-0000-1234（奥様）",
      hint: contact?.relation ? `続柄: ${contact.relation}` : undefined,
      onChange: (value) => {
        setPhoneDraft({ index, text: value });
        onContactsChange(row.pairId, setContactPhone(row.mail.contacts, index, value));
      },
      onBlur: () => setPhoneDraft(null),
    };
  };
  const headerFields: HeaderField[] = [
    cellField("PJコード", PJ_COL, "2101230101"),
    cellField("引渡日", HANDOVER_COL, "2025/9/26"),
    cellField("物件名", PROPERTY_COL),
    cellField("施主名", OWNER_COL, "山田　太郎"),
    {
      label: "施主名 (カナ)",
      value: row.mail.ownerKana,
      placeholder: "ヤマダ　タロウ",
      hint: "空欄なら括弧ごと省いて出力します（メール文と共通です）",
      warnWhenEmpty: true,
      onChange: (value) => onKanaChange(row.pairId, value),
    },
    cellField("住所", ADDRESS_COL),
    phoneField(0),
    phoneField(1),
    cellField("受付日", RECEPTION_DATE_COL, "2026/7/22"),
    {
      label: "受付者",
      value: row.report.receptionist ?? "",
      placeholder: RECEPTIONIST,
      hint: `空欄なら「${RECEPTIONIST}」で出力します（結果テーブルの受付者列とは別です）`,
      onChange: setReceptionist,
    },
  ];

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

  return (
    <ModalShell
      label={`完了報告書 ${row.ownerDisplay}`}
      onClose={onClose}
      panelClassName="max-h-[90vh] w-full max-w-5xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
    >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold">完了報告書 — {row.ownerDisplay}</h3>
            <p className="mt-0.5 text-xs text-slate-500">
              見出しの各欄と指示内容はここで直すと結果テーブルにも書き戻されます（受付者だけは完了報告書の値）。作業内容・是正内容以降は空欄のままです
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

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {headerFields.map((f) => (
            <label key={f.label} className="block text-sm">
              <span className="font-medium">{f.label}</span>
              <input
                value={f.value}
                placeholder={f.placeholder}
                onChange={(e) => f.onChange(e.target.value)}
                onBlur={f.onBlur}
                className={`mt-1 w-full rounded border px-2 py-1.5 text-sm ${
                  f.warnWhenEmpty && !f.value
                    ? "border-amber-300 bg-amber-50"
                    : "border-slate-300 bg-white"
                }`}
              />
              {f.hint && <span className="mt-0.5 block text-xs text-slate-500">{f.hint}</span>}
            </label>
          ))}
        </div>

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
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">
              指示内容
              <span className="ml-2 text-xs font-normal text-slate-500">
                ここで直すと結果テーブルの「{summaryLabel}」にも反映されます
                {split && "（工事区分ごとに、その行の欄へ書き戻します）"}
              </span>
            </p>
            {!split && (
              <button
                type="button"
                onClick={() => editGroupItems(0, [...itemsOf(0), ""])}
                className="cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-slate-50"
              >
                項目を追加
              </button>
            )}
          </div>

          {(() => {
            // №は工事区分をまたいで通しで振る (報告書の並びと同じ)。
            // 空欄は報告書に載らないので数えない
            let no = 0;
            return groups.map((group, gi) => {
              const items = itemsOf(gi);
              const numbers = items.map((s) => (s.trim() ? ++no : null));
              return (
                <section
                  key={group.catIndex ?? "all"}
                  className={split ? "mt-2 rounded-lg border border-slate-200 p-2" : ""}
                >
                  {split && (
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-xs font-medium text-slate-600">
                        {group.label}
                        <span className="ml-1 font-normal text-slate-400">{items.length}件</span>
                      </p>
                      <button
                        type="button"
                        onClick={() => editGroupItems(gi, [...items, ""])}
                        className="cursor-pointer rounded-md border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium hover:bg-slate-50"
                      >
                        項目を追加
                      </button>
                    </div>
                  )}
                  {items.length === 0
                    ? split && (
                        <p className="mt-1 text-xs text-slate-400">この区分の項目はありません</p>
                      )
                    : (
                      <ul className="mt-1.5 space-y-1.5">
                        {items.map((item, i) => (
                          // 並べ替えはしないので、位置をそのままキーにする
                          // biome-ignore lint/suspicious/noArrayIndexKey: 入力欄の位置と対応させるため
                          <li key={`${gi}-${i}`} className="flex items-center gap-2">
                            <span className="w-16 shrink-0 text-right text-xs text-slate-500">
                              {numberLabel(numbers[i])}
                            </span>
                            <input
                              value={item}
                              onChange={(e) =>
                                editGroupItems(
                                  gi,
                                  items.map((v, j) => (j === i ? e.target.value : v)),
                                )
                              }
                              placeholder="1階洋室 天井クロス：クロス表面に凹凸あり"
                              className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm"
                            />
                            <button
                              type="button"
                              title="この項目を削除"
                              onClick={() => editGroupItems(gi, items.filter((_, j) => j !== i))}
                              className="shrink-0 cursor-pointer rounded px-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-600"
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  {group.parts.notes.length > 0 && (
                    <p className="mt-1.5 text-xs text-slate-500">
                      メモ (完了報告書には載せません): {group.parts.notes.join(" / ")}
                    </p>
                  )}
                </section>
              );
            });
          })()}

          {totalItems === 0 && (
            <p className="mt-1 text-sm text-amber-800">
              指示内容が空です。「項目を追加」で入力するか、{summaryLabel}を入力してから作成してください
            </p>
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
                  この端末に登録済み。以後のPDFはこの書体で作ります ({fontInfo.regularName} /{" "}
                  {fontInfo.boldName}, {(fontInfo.bytes / 1024 / 1024).toFixed(1)}MB)
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
          <details className="mt-2 text-xs text-slate-500">
            <summary className="cursor-pointer select-none">游ゴシックを使うには</summary>
            <p className="mt-1">
              游ゴシックは Windows / Microsoft Office に付属する書体で、再配布はできませんが、
              ライセンスを持つ端末で自分の文書に埋め込むことは許可されています (フォント側の埋め込み設定も許可)。
              登録したフォントはこの端末の中だけに保存され、外部へは送信されません。
            </p>
            <p className="mt-1">
              Mac は <code>/Applications/Microsoft Word.app/Contents/Resources/DFonts/YuGothR.ttc</code>{" "}
              と <code>YuGothB.ttc</code>、Windows は <code>C:\Windows\Fonts\</code> の同名ファイルです。
            </p>
          </details>
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
    </ModalShell>
  );
}
