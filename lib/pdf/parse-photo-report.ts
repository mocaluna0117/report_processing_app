import type {
  Confidence,
  DefectBlock,
  FieldValue,
  PhotoReportData,
  TextToken,
} from "@/lib/types";
import {
  CONTINUATION_MARKER,
  HEADER_ROWS,
  HEADER_ROW_TOL,
  HEADER_X,
  SLOT,
  SLOT_BANDS,
  SLOT_X,
  SPECIAL_NOTE_MARKER,
} from "./constants";

export interface ParseOptions {
  /** ファイル名先頭の8桁日付 (YYYYMMDD)。点検日との整合チェックに使う */
  fileNameDate?: string;
}

function field(
  value: string,
  confidence: Confidence = "ok",
  warnings: string[] = [],
): FieldValue {
  return { value, confidence, warnings };
}

function failed(warning: string): FieldValue {
  return field("", "fail", [warning]);
}

const NO_ABNORMALITY = /異常(なし|無し|無)/;

function byXY(a: TextToken, b: TextToken): number {
  return a.y - b.y || a.x - b.x;
}

function inRow(t: TextToken, rowY: number): boolean {
  return Math.abs(t.y - rowY) <= HEADER_ROW_TOL;
}

/** "2025 9 26" のように1トークンへ結合されている場合に備えて数字トークンを分割する */
function splitNumericParts(tokens: TextToken[]): string[] {
  const parts: string[] = [];
  for (const t of tokens.slice().sort((a, b) => a.x - b.x)) {
    for (const p of t.str.split(/\s+/)) {
      if (/^\d{1,4}$/.test(p)) parts.push(p);
    }
  }
  return parts;
}

function toDate(parts: string[]): string | null {
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map(Number);
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`;
}

/** 行バンドから外れた場合のフォールバック: ページ全文から日付らしき並びを行単位で拾う */
function fallbackDates(page1: TextToken[]): string[] {
  const rows = new Map<number, TextToken[]>();
  for (const t of page1) {
    const key = Math.round(t.y / 6) * 6;
    const row = rows.get(key) ?? [];
    row.push(t);
    rows.set(key, row);
  }
  const found: { y: number; date: string }[] = [];
  for (const [, row] of rows) {
    const text = row
      .sort((a, b) => a.x - b.x)
      .map((t) => t.str)
      .join(" ");
    const m = text.match(/(20\d{2})\D+(\d{1,2})\D+(\d{1,2})(?!\d)/);
    if (m) {
      const date = toDate([m[1], m[2], m[3]]);
      if (date) found.push({ y: row[0].y, date });
    }
  }
  return found.sort((a, b) => a.y - b.y).map((f) => f.date);
}

interface RawSlot {
  page: number;
  slot: number;
  location: string;
  part: string;
  symptom: string;
  response: string;
  tempFeel: string;
  followup: string;
  remarks: string;
}

function isEmptySlot(s: RawSlot): boolean {
  return (
    !s.location &&
    !s.part &&
    !s.symptom &&
    !s.response &&
    !s.tempFeel &&
    !s.followup &&
    !s.remarks
  );
}

/** 備考のみ (場所・部位・症状・対応・事後対応が空) のブロックか */
function isRemarksOnly(s: RawSlot): boolean {
  return (
    !s.location && !s.part && !s.symptom && !s.response && !s.followup && !!s.remarks
  );
}

function parseSlots(tokens: TextToken[], pageCount: number) {
  const defects: DefectBlock[] = [];
  const standaloneNotes: string[] = [];
  const specialNotes: string[] = [];

  for (let page = 2; page <= pageCount; page++) {
    const pageTokens = tokens.filter(
      (t) =>
        t.page === page &&
        t.x < SLOT_X.textColumnMax &&
        t.y >= SLOT.top - 10,
    );
    if (pageTokens.length === 0) continue;

    // 各トークンをただ1つのスロットに割り当てる (バンドの許容ずれで隣接スロットに
    // 二重計上されないよう、先にy範囲で排他的に分割してからdyバンドで欄を分類する)
    const bySlot: TextToken[][] = [[], [], []];
    for (const t of pageTokens) {
      const idx = Math.min(
        2,
        Math.max(0, Math.floor((t.y - (SLOT.top - 10)) / SLOT.pitch)),
      );
      bySlot[idx].push(t);
    }

    for (let slot = 0; slot < 3; slot++) {
      const slotTop = SLOT.top + slot * SLOT.pitch;
      const firstLineY = slotTop + SLOT.firstLineOffset;
      const slotTokens = bySlot[slot];

      const pick = (
        band: { min: number; max: number },
        xPred: (x: number) => boolean = () => true,
      ) =>
        slotTokens
          .filter((t) => {
            const dy = t.y - firstLineY;
            return dy >= band.min && dy <= band.max && xPred(t.x);
          })
          .sort(byXY);

      const joinLines = (ts: TextToken[], sep: string) =>
        ts.map((t) => t.str).join(sep).trim();

      const raw: RawSlot = {
        page,
        slot,
        location: joinLines(
          pick(SLOT_BANDS.locationPart, (x) => x < SLOT_X.locationMax),
          " ",
        ),
        part: joinLines(
          pick(SLOT_BANDS.locationPart, (x) => x >= SLOT_X.locationMax),
          " ",
        ),
        symptom: joinLines(pick(SLOT_BANDS.symptom), " "),
        response: joinLines(
          pick(SLOT_BANDS.responseTemp, (x) => x < SLOT_X.responseMax),
          " ",
        ),
        tempFeel: joinLines(
          pick(SLOT_BANDS.responseTemp, (x) => x >= SLOT_X.responseMax),
          " ",
        ),
        followup: joinLines(pick(SLOT_BANDS.followup), " "),
        // 備考は日本語の折返しなので区切り無しで連結
        remarks: joinLines(pick(SLOT_BANDS.remarks), ""),
      };

      if (isEmptySlot(raw)) continue; // テンプレートの余り枠

      if (isRemarksOnly(raw)) {
        if (SPECIAL_NOTE_MARKER.test(raw.remarks)) {
          specialNotes.push(raw.remarks.replace(SPECIAL_NOTE_MARKER, "").trim());
        } else if (defects.length > 0) {
          // 継続ブロック: 直前の不具合の備考に連結 (「次頁に続く」マーカーは除去。同一ページ内継続もある)
          const prev = defects[defects.length - 1];
          prev.remarks =
            prev.remarks.replace(CONTINUATION_MARKER, "").trimEnd() + raw.remarks;
        } else {
          standaloneNotes.push(raw.remarks);
        }
        continue;
      }

      defects.push({ ...raw });
    }
  }

  return { defects, standaloneNotes, specialNotes };
}

/**
 * 写真報告書のテキストトークンから8項目+不具合ブロックを抽出する (純関数)。
 * 座標仕様は lib/pdf/constants.ts を参照。
 */
export function parsePhotoReport(
  tokens: TextToken[],
  pageCount: number,
  opts: ParseOptions = {},
): PhotoReportData {
  const page1 = tokens.filter((t) => t.page === 1);
  const rowA = page1.filter((t) => inRow(t, HEADER_ROWS.rowA));
  const rowB = page1.filter((t) => inRow(t, HEADER_ROWS.rowB));
  const rowC = page1.filter((t) => inRow(t, HEADER_ROWS.rowC));

  // --- PJ (契約番号) ---
  let pj: FieldValue;
  const pjToken = rowA
    .filter((t) => t.x < HEADER_X.pjMax)
    .sort((a, b) => a.x - b.x)
    .find((t) => /^\d{10}$/.test(t.str));
  if (pjToken) {
    pj = field(pjToken.str);
  } else {
    const anywhere = page1.find((t) => /^\d{10}$/.test(t.str));
    pj = anywhere
      ? field(anywhere.str, "warn", ["契約番号を既定位置以外から取得しました"])
      : failed("契約番号(10桁)が見つかりません");
  }

  // --- 現場名 → 事業者 / 物件名称 ---
  // 日付は「2026」「10」「26」の分離トークン or 「2026 10 26」の結合トークンで来る
  const isDateFragment = (s: string) => /^\d{1,4}(\s+\d{1,2}){0,2}$/.test(s.trim());
  const siteTokens = rowA
    .filter(
      (t) =>
        (t.x >= HEADER_X.siteMin && t.x < HEADER_X.siteMax) ||
        // 現場名が長い場合に日付セル領域まで食い込んで分割されるケース (数字断片は日付なので除外)
        (t.x >= HEADER_X.dateMin && !isDateFragment(t.str)),
    )
    .sort((a, b) => a.x - b.x);
  const siteName = siteTokens.map((t) => t.str).join("").trim();
  let developer: FieldValue;
  let propertyName: FieldValue;
  if (!siteName) {
    developer = failed("現場名が見つかりません");
    propertyName = failed("現場名が見つかりません");
  } else {
    const m = siteName.match(/^【(.+?)】(.*)$/s);
    if (m) {
      developer = field(m[1].trim());
      propertyName = field(m[2].trim());
    } else if (siteName.startsWith("【")) {
      developer = field("", "warn", ["現場名の【】が閉じていません"]);
      propertyName = field(siteName, "warn", ["現場名の【】が閉じていません"]);
    } else {
      // 【】が無い現場名は正常ケース (事業者=空欄)
      developer = field("");
      propertyName = field(siteName);
    }
  }

  // --- 引渡日 / 点検日 ---
  const dateTokens = (row: TextToken[]) =>
    row.filter((t) => t.x >= HEADER_X.dateMin && /^[\d\s]+$/.test(t.str));
  let handoverDate = ((): FieldValue => {
    const d = toDate(splitNumericParts(dateTokens(rowA)));
    return d ? field(d) : failed("引渡日を抽出できません");
  })();
  let inspectionDate = ((): FieldValue => {
    const d = toDate(splitNumericParts(dateTokens(rowB)));
    return d ? field(d) : failed("点検日を抽出できません");
  })();

  // バンドから取れない場合は行ベースのフォールバック (上=引渡日, 下=点検日)
  if (handoverDate.confidence === "fail" || inspectionDate.confidence === "fail") {
    const dates = fallbackDates(page1);
    if (handoverDate.confidence === "fail" && dates[0]) {
      handoverDate = field(dates[0], "warn", ["引渡日を行解析のフォールバックで取得しました"]);
    }
    if (inspectionDate.confidence === "fail" && dates[1]) {
      inspectionDate = field(dates[1], "warn", ["点検日を行解析のフォールバックで取得しました"]);
    }
  }

  // 整合チェック: 点検日はファイル名の8桁日付と一致するはず
  if (opts.fileNameDate && inspectionDate.value) {
    const fromFile = `${opts.fileNameDate.slice(0, 4)}/${opts.fileNameDate.slice(4, 6)}/${opts.fileNameDate.slice(6, 8)}`;
    if (inspectionDate.value !== fromFile) {
      inspectionDate = {
        ...inspectionDate,
        confidence: "warn",
        warnings: [
          ...inspectionDate.warnings,
          `点検日(${inspectionDate.value})がファイル名の日付(${fromFile})と一致しません`,
        ],
      };
    }
  }

  // --- 住所 ---
  const addressStr = rowB
    .filter((t) => t.x < HEADER_X.addressMax)
    .sort((a, b) => a.x - b.x)
    .map((t) => t.str)
    .join("")
    .trim();
  const address = !addressStr
    ? failed("住所が見つかりません")
    : /^(東京都|北海道|大阪府|京都府|.{2,3}県)/.test(addressStr)
      ? field(addressStr)
      : field(addressStr, "warn", ["住所が都道府県名で始まっていません"]);

  // --- お客様氏名 ---
  const ownerRaw = rowC
    .filter((t) => t.x < HEADER_X.ownerMax)
    .sort((a, b) => a.x - b.x)
    .map((t) => t.str)
    .filter((s) => s !== "様")
    .join(" ")
    .replace(/[\s　]*様$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const ownerName = ownerRaw ? field(ownerRaw) : failed("施主名が見つかりません");

  // --- 受付種別 (点検時期) ---
  const timingRaw = rowC
    .filter((t) => t.x >= HEADER_X.timingMin && t.x < HEADER_X.timingMax)
    .sort((a, b) => a.x - b.x)
    .map((t) => t.str)
    .join("")
    .replace(/[かカヵ]月/, "ヶ月")
    .trim();
  const inspectionTiming = !timingRaw
    ? failed("点検時期が見つかりません")
    : /^(\d+(年|ヶ月)|半年)$/.test(timingRaw)
      ? field(timingRaw)
      : field(timingRaw, "warn", ["点検時期が想定パターン(例: 1年, 3ヶ月)と異なります"]);

  // --- テンプレート指紋チェック ---
  const templateRecognized = !(
    pj.confidence === "fail" && handoverDate.confidence === "fail"
  );

  if (!templateRecognized) {
    const unknown = (label: string): FieldValue =>
      field("", "fail", [`未知のテンプレートのため${label}を抽出できません`]);
    return {
      pj: unknown("契約番号"),
      inspectionTiming: unknown("点検時期"),
      developer: unknown("事業者"),
      propertyName: unknown("物件名称"),
      ownerName: unknown("施主名"),
      address: unknown("住所"),
      handoverDate: unknown("引渡日"),
      inspectionDate: unknown("点検日"),
      defects: [],
      standaloneNotes: [],
      specialNotes: [],
      noAbnormalityOnPage1: false,
      templateRecognized: false,
    };
  }

  const { defects, standaloneNotes, specialNotes } = parseSlots(tokens, pageCount);

  return {
    pj,
    inspectionTiming,
    developer,
    propertyName,
    ownerName,
    address,
    handoverDate,
    inspectionDate,
    defects,
    standaloneNotes,
    specialNotes,
    noAbnormalityOnPage1: page1.some((t) => NO_ABNORMALITY.test(t.str)),
    templateRecognized: true,
  };
}
