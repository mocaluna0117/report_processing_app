/**
 * 一覧のページ送り（件数表示の読み取りと「次へ」の見つけ方）。
 *
 * 移植元: tenmatsu.py 3108-3215
 * ブラウザ側からも使うので、Playwright にも server-only にも依存しない。
 */
import { toAscii } from "./text";

/** 件数表示 `(総件数, 先頭, 末尾)`。「697件中 101件～200件目」→ `[697, 101, 200]` */
export type Pager = readonly [total: number, first: number, last: number];

/**
 * 「（697件中 101件～200件目）」の形。
 * 波ダッシュは全角チルダ(U+FF5E)・波ダッシュ(U+301C)・ハイフン類のどれも来るので全部許す。
 */
const PAGER_RE =
  /([\d,]+)\s*件中\s*([\d,]+)\s*件?\s*[\u301c\uff5e~\-\u2010\u2011\u2212\u30fc]\s*([\d,]+)\s*件目/;

/**
 * 件数表示を読む。読めなければ null。
 *
 * ★これが読めると「最後のページまで見た」と「途中で止まった」を区別できる。
 *   読めない画面もありうるので、読めなければ null を返して呼び出し側の判定に任せる。
 */
export function parsePagerText(text: string | null | undefined): Pager | null {
  if (!text) return null;
  const m = PAGER_RE.exec(toAscii(String(text)));
  if (!m) return null;
  const n = (g: string) => Number(g.replace(/,/g, ""));
  return [n(m[1]), n(m[2]), n(m[3])];
}

/** 件数表示から今のページ番号（1始まり）を出す。読めなければ null */
export function currentPageNo(pager: Pager | null | undefined): number | null {
  if (!pager) return null;
  const [, first, last] = pager;
  const size = last - first + 1;
  if (size <= 0) return null;
  return Math.floor((first - 1) / size) + 1;
}

/** ページ送りの要素（画面から集めたもの） */
export interface PagerAction {
  index: number;
  onclick: string;
  /** 表示文字（小文字にしてある） */
  text: string;
  cls: string;
}

export type NextHow = "icon" | "number" | "third" | "config" | "text";

export interface NextCandidate {
  how: NextHow;
  /** 押す要素の番号。設定の JS を実行するときは null */
  index: number | null;
  js: string;
}

/** 「次へ」を表す表示文字・アイコン名（Material Icons の名前も来る） */
const NEXT_WORDS = ["chevron_right", "navigate_next", "keyboard_arrow_right", "arrow_forward", "next", "次"];
/** 「前へ」側の目印。これを含むものは「次へ」にしない */
const PREV_WORDS = ["prev", "before", "left"];
const PAGEFEED_ARG_RE = /pageFeed\(\s*(-?\d+)\s*\)/;

/**
 * ページ送りの要素を集める JS。onclick に pageFeed( を持つものが対象。
 * 移植元 tenmatsu.py:3148-3155 をそのまま写した。
 */
export const PAGER_ACTIONS_JS = `() => [...document.querySelectorAll('[onclick*="pageFeed("]')]
    .map((el, i) => ({
        index: i,
        onclick: el.getAttribute('onclick') || '',
        text: (el.innerText || el.textContent || '').trim().toLowerCase(),
        cls: typeof el.className === 'string' ? el.className : '',
    }))`;

/**
 * 「次へ」の候補を優先順に並べる。
 *
 * ★楽楽精算の「次へ」の onclick は**行き先のページ番号を埋め込んでページごとに描き直される**
 *   （1ページ目では pageFeed(1)、2ページ目では pageFeed(2)）。設定に固定した pageFeed(1) では
 *   **2ページ目から先へ進めない**（実際に3ページ目以降を取りこぼした）。
 *   毎ページ画面から読み直すのが本筋で、設定の JS は最後の手段にする。
 *
 * 見つけ方の優先順:
 *   icon   … 表示文字・アイコン名が「次へ」を表す（「前へ」側を除く）
 *   number … onclick の数字が「次のページ番号」（0始まり・1始まりの両方を許す）
 *   third  … 要素がちょうど4つ（|< < > >|）なら3つ目
 *   config … 設定の JS
 * 同じ要素が複数の見つけ方で当たっても1回だけ入れる。
 */
export function rankNextPageActions(
  actions: readonly PagerAction[],
  pager: Pager | null | undefined,
  fallbackJs: string | null | undefined,
): NextCandidate[] {
  const ranked: NextCandidate[] = [];
  const used = new Set<number>();
  const add = (how: NextHow, a: PagerAction) => {
    if (used.has(a.index)) return;
    used.add(a.index);
    ranked.push({ how, index: a.index, js: `() => { ${a.onclick} }` });
  };

  for (const a of actions) {
    const hay = `${a.text ?? ""} ${a.cls ?? ""}`.toLowerCase();
    if (NEXT_WORDS.some((w) => hay.includes(w)) && !PREV_WORDS.some((w) => hay.includes(w))) {
      add("icon", a);
    }
  }

  const pageNo = currentPageNo(pager);
  if (pageNo !== null) {
    const wants = new Set([pageNo, pageNo + 1]); // 0始まりの次 / 1始まりの次
    for (const a of actions) {
      const m = PAGEFEED_ARG_RE.exec(a.onclick ?? "");
      if (m && wants.has(Number(m[1]))) add("number", a);
    }
  }

  if (actions.length === 4) add("third", actions[2]);

  if (fallbackJs) ranked.push({ how: "config", index: null, js: fallbackJs });
  return ranked;
}
