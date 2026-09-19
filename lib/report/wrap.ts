/**
 * 完了報告書の指示内容を、文字を小さくせずに折り返すための純関数。
 *
 * ★本紙の指示内容の枠は1行 全角41文字 (11pt)。長い項目と補足は**次の枠 (行) に続けて**書く
 *   (利用者の決定 2026-09-19)。5つの枠に入らなければ、6件以上のときと同じく別紙へ回す。
 * ★幅の数え方は呼ぶ側から渡す。既定は charUnits (全角1・半角0.5) で、PDFの書体に依らず
 *   Excelと同じ位置で折り返せるようにしている。
 */

/** 半角として数える文字 (ASCII と半角カナ) */
const HALF_WIDTH = /[\x20-\x7e｡-ﾟ]/;
/** 行頭に置かない字 (句読点・閉じ括弧・長音・小書き)。前の行末の1字を連れて次の行へ送る */
const NO_LINE_START = new Set("、。，．）」』】〕〉》〙・ー〜ゝゞヽヾっゃゅょァィゥェォッャュョヵヶ");
/** 行末に置かない字 (開き括弧)。次の行の先頭へ送る */
const NO_LINE_END = new Set("（「『【〔〈《〘");
/** 英数字の連続 (型番・URL) は途中で切らない */
const WORD_CHAR = /[A-Za-z0-9_\-./:@#%&=?+]/;

/** 全角を1・半角を0.5 として数えた幅 */
export function charUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += HALF_WIDTH.test(ch) ? 0.5 : 1;
  return units;
}

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
  measure: (s: string) => number = charUnits,
): string[] {
  const body = text.trim();
  if (!body) return [];
  const fits = (s: string) => measure(s) <= maxWidth + 0.01;
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
