import { formatPhenomena } from "./format";
import type { SummarizeRequest } from "./types";

/**
 * アフター受付内容は「不具合の事象」のみを載せる方針のため、
 * 備考の自由記述から 要望・対応方針・写真等のメモ を落として事象だけを残す。
 */

/** この語を含む節は落とす (お客様の要望・社内の対応方針・写真などの付随メモ) */
const DROP_CLAUSE =
  /(希望|要望|ご依頼|お願い|無償|有償|見積|継続対応|別日対応|是正不可|対応可否|ご確認|取付|取り付け|付けたい|直してほし|直して欲し|申告|写真|品番|貴社|弊社)/;

/** 事象の文末に付く報告表現。事象は残したいので語尾だけ削る */
const REPORTING_SUFFIX =
  /(と(の)?(こと|事)(でございます|です|でした)?|と仰せ|と仰っています|と申されて.*|と伺って.*|と説明され.*)$/;

interface Clause {
  /** 区切り文字を除いた本文 */
  text: string;
  /** 元の区切り文字 (、 または 。 、無い場合は空) */
  delim: string;
}

/** 句点・読点で節に分ける (元の区切り文字を保持して読みやすさを保つ) */
function splitClauses(raw: string): Clause[] {
  return raw
    .replace(/\s+/g, "")
    .split(/(?<=[。、])/)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const m = /[。、]$/.exec(c);
      return { text: m ? c.slice(0, -1) : c, delim: m ? m[0] : "" };
    });
}

/** 節末の報告表現・宙ぶらりんの接続語尾を削る */
function tidyClause(text: string): string {
  return text
    .replace(REPORTING_SUFFIX, "")
    .replace(/(ため|ので|ものの)$/, "")
    .trim();
}

/** 残した節を元の区切り文字でつなぐ (末尾の区切りは落とす) */
function joinClauses(clauses: Clause[]): string {
  return clauses
    .map((c, i) => c.text + (i < clauses.length - 1 ? c.delim : ""))
    .join("")
    .replace(/[、。]+$/, "")
    .trim();
}

/** 要望・対応方針の節を落として事象だけにする */
export function stripRequests(text: string): string {
  const kept = splitClauses(text)
    .filter((c) => !DROP_CLAUSE.test(c.text))
    .map((c) => ({ ...c, text: tidyClause(c.text) }))
    .filter((c) => c.text.length > 0);
  return joinClauses(kept);
}

/**
 * 備考から事象を1つ取り出す。取り出せなければ空文字。
 * 先頭の節が要望・対応方針だった場合は、その項目自体が要望であり事象が無いと判断して空を返す
 * (後続の節はその要望の理由なので、事象として載せると意味がずれる)。
 */
function firstPhenomenon(text: string, max = 45): string {
  const clauses = splitClauses(text);
  if (clauses.length === 0 || DROP_CLAUSE.test(clauses[0].text)) return "";
  const s = tidyClause(clauses[0].text);
  if (s.length < 5) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function truncate(text: string, max: number): string {
  const s = stripRequests(text);
  if (s.length < 5) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * LLMを使わない定型要約 (Geminiキー未設定時・API失敗時のフォールバック)。
 * 外部送信ゼロで決定的に動く。要望・対応方針は含めず、不具合の事象のみを1行ずつ並べる。
 */
export function ruleBasedSummary(req: SummarizeRequest): string {
  const items = req.defects
    .map((d) => {
      const place = [d.location, d.part].filter(Boolean).join(" ");
      // 症状欄が「その他（備考）」のときは備考から事象を拾う。
      // 拾えない場合 (要望だけが書かれている項目) はこの項目自体を載せない
      const symptom =
        d.symptom && !/その他/.test(d.symptom) ? d.symptom : firstPhenomenon(d.remarks);
      if (!symptom) return "";
      return `${place ? `${place}の` : ""}${symptom}`;
    })
    .filter(Boolean);

  // 特記事項も不具合の事象なので、同じ番号付きの一覧に含める
  for (const n of req.specialNotes) {
    const t = truncate(n, 80);
    if (t) items.push(t);
  }

  const notes = req.standaloneNotes.map((n) => truncate(n, 80)).filter(Boolean);
  return formatPhenomena(items, notes);
}
