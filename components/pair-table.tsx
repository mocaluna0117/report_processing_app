"use client";

import type { UploadedFile } from "@/lib/process";

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
  onChange,
  disabled,
}: {
  pairs: PairView[];
  photoFiles: UploadedFile[];
  inspectionFiles: UploadedFile[];
  onChange: (pairId: string, side: "photo" | "inspection", fileId: string | null) => void;
  disabled?: boolean;
}) {
  const usedPhotos = new Set(pairs.flatMap((p) => (p.photoId ? [p.photoId] : [])));
  const usedInspections = new Set(
    pairs.flatMap((p) => (p.inspectionId ? [p.inspectionId] : [])),
  );

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="whitespace-nowrap border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
            <th className="w-28 px-3 py-2">点検日</th>
            <th className="w-36 px-3 py-2">施主</th>
            <th className="px-3 py-2">写真報告書</th>
            <th className="px-3 py-2">点検報告書</th>
            <th className="w-24 px-3 py-2">状態</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((p) => (
            <tr key={p.id} className="border-b border-slate-100 last:border-0">
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
                {p.needsReview ? (
                  <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                    要確認
                  </span>
                ) : p.photoId && p.inspectionId ? (
                  <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                    ペア済
                  </span>
                ) : (
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                    不足
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
