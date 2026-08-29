// 管理ID・物件番号から PJ (10桁の契約番号) を作る。
import { toHalfWidthAlnum, trimWide } from "@/lib/text";
import { HYPHENS } from "@/lib/phone";

const HYPHEN_RE = new RegExp(`[${HYPHENS}]`, "g");

/** 比較しやすい形に整える (全角スペース除去・英数半角・ハイフン統一・大文字) */
function canonical(raw: string): string {
  return toHalfWidthAlnum(trimWide(raw)).replace(HYPHEN_RE, "-").toUpperCase();
}

export interface PjConversion {
  pj: string | null;
  /** dx: この行は点検保守台帳側にあるので取り込まない */
  skip?: "dx";
  issue?: string;
}

/**
 * 助っ人クラウドの管理ID → PJ。
 * 規則は表で持ち、新しい形式が分かったら1行足すだけで増やせるようにする。
 */
const RULES: readonly [RegExp, (m: RegExpExecArray) => string][] = [
  [/^B(\d)(\d)-(\d)$/, (m) => `2100${m[1]}${m[2]}0${m[3]}01`],
  [/^(\d{4})-\d$/, (m) => `10${m[1]}0101`],
  [/^(\d{3})-\d$/, (m) => `110${m[1]}0101`],
  [/^(\d{2})-\d$/, (m) => `1100${m[1]}0101`],
  [/^(\d)-\d$/, (m) => `11000${m[1]}0101`],
];

export function managementIdToPj(raw: string): PjConversion {
  const id = canonical(raw);
  if (!id) return { pj: null, issue: "管理IDが空のためPJを特定できません" };
  if (id === "DX") return { pj: null, skip: "dx" };
  for (const [pattern, build] of RULES) {
    const m = pattern.exec(id);
    if (m) return { pj: build(m) };
  }
  return { pj: null, issue: `管理ID「${raw.trim()}」からPJを変換できません` };
}

export interface BukkenParse {
  pj: string | null;
  skipReason?: string;
}

/** 点検保守台帳の物件番号 → PJ。末尾が01でないもの・使用禁止のものは取り込まない */
export function parseBukkenNumber(raw: string): BukkenParse {
  const value = canonical(raw);
  if (!value) return { pj: null, skipReason: "物件番号が空" };
  if (/^DONOTUSE/.test(value)) return { pj: null, skipReason: "使用禁止 (DONOTUSE)" };
  if (/^[A-Z_]+$/.test(value)) return { pj: null, skipReason: "技術行 (見出しのキー)" };
  const digits = /^(?:\(BS\))?(\d{10})$/.exec(value)?.[1];
  if (!digits) return { pj: null, skipReason: "物件番号の形式が不正" };
  if (!digits.endsWith("01")) return { pj: null, skipReason: "物件番号の末尾が01以外" };
  return { pj: digits };
}
