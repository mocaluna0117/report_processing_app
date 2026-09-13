"use client";

import type { UploadedFile } from "@/lib/process";
import { canRun, type PairRunState } from "@/lib/run-plan";

export interface PairView {
  id: string;
  photoId: string | null;
  inspectionId: string | null;
  date: string | null;
  ownerDisplay: string;
  needsReview: boolean;
  /** ユーザーが手動で修正したペア (ファイル追加時の自動再ペアリングで壊さない) */
  manual?: boolean;
}

const CHECKBOX_CLASS =
  "h-4 w-4 rounded border-slate-300 disabled:cursor-not-allowed disabled:opacity-50";

const BADGE_CLASS = "inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium";

/** 処理の進み具合の見せ方。色だけでなく必ず文字でも出す */
const RUN_BADGE: Record<PairRunState, { text: string; className: string; title: string }> = {
  unprocessed: {
    text: "未処理",
    className: "bg-sky-100 text-sky-800",
    title: "まだ処理していません",
  },
  processed: {
    text: "処理済み",
    className: "bg-emerald-100 text-emerald-800",
    title: "処理済みです。下の抽出結果に行があります",
  },
  failed: {
    text: "処理に失敗",
    className: "bg-red-100 text-red-700",
    title: "前回の処理に失敗しました。チェックを入れるともう一度実行できます",
  },
  duplicate: {
    text: "重複の可能性",
    className: "bg-orange-100 text-orange-900",
    title:
      "同じ施主・点検日の処理済みがあります (再ダウンロードした重複ファイルの可能性)。処理すると抽出結果の行がもう1つ増えます",
  },
  "no-photo": {
    text: "写真報告書なし",
    className: "bg-slate-200 text-slate-600",
    title: "写真報告書が無いので処理できません。プルダウンで選んでください",
  },
};

function FileSelect({
  value,
  options,
  usedIds,
  onChange,
  disabled,
}: {
  value: string | null;
  options: UploadedFile[];
  usedIds: Set<string>;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      className={`w-full truncate rounded-md border px-2 py-1.5 text-sm ${
        value ? "border-slate-300 bg-white" : "border-amber-400 bg-amber-50"
      }`}
    >
      <option value="">— 未選択 —</option>
      {options.map((f) => (
        <option
          key={f.id}
          value={f.id}
          disabled={f.id !== value && usedIds.has(f.id)}
        >
          {f.name}
        </option>
      ))}
    </select>
  );
}

export function PairTable({
  pairs,
  photoFiles,
  inspectionFiles,
  states,
  selected,
  onToggle,
  onChange,
  disabled,
}: {
  pairs: PairView[];
  photoFiles: UploadedFile[];
  inspectionFiles: UploadedFile[];
  /** ペアごとの処理の進み具合 (lib/run-plan.ts の pairStates) */
  states: ReadonlyMap<string, PairRunState>;
  /** 処理するペア */
  selected: ReadonlySet<string>;
  onToggle: (pairId: string, next: boolean) => void;
  onChange: (pairId: string, side: "photo" | "inspection", fileId: string | null) => void;
  disabled?: boolean;
}) {
  const usedPhotos = new Set(pairs.flatMap((p) => (p.photoId ? [p.photoId] : [])));
  const usedInspections = new Set(
    pairs.flatMap((p) => (p.inspectionId ? [p.inspectionId] : [])),
  );

  const label = (p: PairView) => {
    const date = p.date
      ? `${Number(p.date.slice(0, 4))}/${Number(p.date.slice(4, 6))}/${Number(p.date.slice(6, 8))}`
      : "";
    return `${p.ownerDisplay || "施主不明"}${date ? ` (${date})` : ""}`;
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="whitespace-nowrap border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
            <th scope="col" className="w-12 px-3 py-2">
              選ぶ
            </th>
            <th scope="col" className="w-28 px-3 py-2">
              点検日
            </th>
            <th scope="col" className="w-36 px-3 py-2">
              施主
            </th>
            <th scope="col" className="px-3 py-2">
              写真報告書
            </th>
            <th scope="col" className="px-3 py-2">
              点検報告書
            </th>
            <th scope="col" className="w-44 px-3 py-2">
              状態
            </th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((p) => {
            const state = states.get(p.id) ?? "unprocessed";
            const runnable = canRun(state);
            const badge = RUN_BADGE[state];
            return (
              <tr
                key={p.id}
                className={`border-b border-slate-100 last:border-0 ${
                  state === "duplicate"
                    ? "bg-orange-50"
                    : state === "processed"
                      ? "bg-slate-50"
                      : ""
                }`}
              >
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(p.id)}
                    disabled={disabled || !runnable}
                    aria-label={`${label(p)} を処理の対象にする`}
                    title={runnable ? undefined : RUN_BADGE["no-photo"].title}
                    onChange={(e) => onToggle(p.id, e.target.checked)}
                    className={CHECKBOX_CLASS}
                  />
                </td>
                <td className="px-3 py-2 text-slate-600">
                  {p.date
                    ? `${Number(p.date.slice(0, 4))}/${Number(p.date.slice(4, 6))}/${Number(p.date.slice(6, 8))}`
                    : "－"}
                </td>
                <td className="px-3 py-2 font-medium">{p.ownerDisplay || "－"}</td>
                <td className="px-3 py-2">
                  <FileSelect
                    value={p.photoId}
                    options={photoFiles}
                    usedIds={usedPhotos}
                    onChange={(id) => onChange(p.id, "photo", id)}
                    disabled={disabled}
                  />
                </td>
                <td className="px-3 py-2">
                  <FileSelect
                    value={p.inspectionId}
                    options={inspectionFiles}
                    usedIds={usedInspections}
                    onChange={(id) => onChange(p.id, "inspection", id)}
                    disabled={disabled}
                  />
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    <span className={`${BADGE_CLASS} ${badge.className}`} title={badge.title}>
                      {badge.text}
                    </span>
                    {p.needsReview && (
                      <span
                        className={`${BADGE_CLASS} bg-amber-100 text-amber-800`}
                        title="ファイル名が完全には一致していません。ペアが正しいか確かめてください"
                      >
                        要確認
                      </span>
                    )}
                    {p.photoId && !p.inspectionId && (
                      <span
                        className={`${BADGE_CLASS} bg-amber-100 text-amber-800`}
                        title="点検報告書が無くても処理できますが、結合PDFは作られず、工事区分も判定できません"
                      >
                        点検報告書なし
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
