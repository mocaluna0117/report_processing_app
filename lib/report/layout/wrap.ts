/**
 * 完了報告書の「指示内容」を、文字を小さくせずに折り返すための純関数。
 *
 * ★本紙の指示内容の枠は1行 約41文字 (11pt・全角)。長い項目は**次の枠 (行) に続けて**書く。
 *   つまり長い項目は5つの枠のうち2つ以上を使い、5枠に入らなければ別紙に回す (利用者の決定 2026-09-19)。
 * ★文字幅は pdf-lib のフォントで測る (measure を注入)。ここでは DOM も pdf-lib も触らない。
 */
import type { Measure } from "@/lib/report/layout/grid";
import { MAIN_SLOTS } from "@/lib/report/model";

/** 行頭に置かない字 (句読点・閉じ括弧・長音・小書き)。前の行末の1字を連れて次の行へ送る */
const NO_LINE_START = new Set("、。，．）」』】〕〉》〙・ー〜ゝゞヽヾっゃゅょァィゥェォッャュョヵヶ");
/** 行末に置かない字 (開き括弧)。次の行の先頭へ送る */
const NO_LINE_END = new Set("（「『【〔〈《〘");
/** 英数字の連続 (型番・URL) は途中で切らない */
const WORD_CHAR = /[A-Za-z0-9_\-./:@#%&=?+]/;

/** 文字列を「切ってよい単位」に分ける (全角1字 / 英数字の連続 / 空白) */
function tokenize(text: string): string[] {
  const units: string[] = [];
  let word = "";
  for (const ch of text) {
    if (WORD_CHAR.test(ch)) {
      word += ch;
      continue;
    }
    if (word) {
      units.push(word);
      word = "";
    }
    units.push(ch);
  }
  if (word) units.push(word);
  return units;
}

/**
 * 幅に入るように詰めて行に分ける。文字の大きさは変えない。
 * 空文字は []。1単位だけで幅を超える英数字の連続は、そこだけ文字で切る。
 */
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  bold: boolean,
  measure: Measure,
): string[] {
  const body = text.replace(/\s+$/, "");
  if (!body) return [];
  const fits = (s: string) => measure(s, size, bold) <= maxWidth + 0.01;
  const lines: string[] = [];
  let line: string[] = [];

  const flush = () => {
    const joined = line.join("").replace(/[ 　]+$/, "");
    if (joined) lines.push(joined);
    line = [];
  };

  const place = (unit: string) => {
    if (fits(line.join("") + unit)) {
      line.push(unit);
      return;
    }
    if (line.length === 0) {
      // この単位だけで1行に入らない (長い英数字など): 文字で切る
      let head = "";
      for (const ch of unit) {
        if (head && !fits(head + ch)) {
          lines.push(head);
          head = "";
        }
        head += ch;
      }
      if (head) line.push(head);
      return;
    }
    // ここで行を折る。★行頭に句読点や閉じ括弧、行末に開き括弧を置かないよう、前の行末を最大2単位まで連れていく
    const carry: string[] = [];
    while (
      line.length > 1 &&
      carry.length < 2 &&
      (NO_LINE_START.has((carry[0] ?? unit)[0]) || NO_LINE_END.has(line[line.length - 1]))
    ) {
      carry.unshift(line.pop() as string);
    }
    flush();
    for (const c of carry) place(c);
    place(unit);
  };

  for (const unit of tokenize(body)) place(unit);
  flush();
  return lines;
}

/** 本紙の指示内容の1項目と、それが使う枠 (行) の位置 */
export interface MainRow {
  /** 丸数字 (①…)。空なら番号なし */
  no: string;
  text: string;
  /** 折り返した行 (1行ずつ本紙の枠に置く) */
  lines: string[];
  /** 0始まりの枠の位置 (16行目が 0) */
  rowStart: number;
  /** 使う枠の数 (= lines.length、最低1) */
  rowSpan: number;
}

/**
 * 項目を本紙の枠に上から順に割り付ける。長い項目は折り返した行数だけ枠を使う。
 * 合計が slots を超えたら null (呼ぶ側が別紙に回す)。
 */
export function planMainRows(
  items: readonly { no: string; text: string }[],
  linesOf: (text: string) => string[],
  slots = MAIN_SLOTS,
): MainRow[] | null {
  const rows: MainRow[] = [];
  let next = 0;
  for (const item of items) {
    const lines = linesOf(item.text);
    const span = Math.max(1, lines.length);
    if (next + span > slots) return null;
    rows.push({ no: item.no, text: item.text, lines: lines.length > 0 ? lines : [""], rowStart: next, rowSpan: span });
    next += span;
  }
  return rows;
}
