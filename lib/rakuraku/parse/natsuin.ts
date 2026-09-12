/**
 * 捺印決裁書の組み立て（純粋な規則）。
 *
 * 捺印決裁書は自分の添付を結合しない。紐づく**専決決裁書の添付から選んで**並べ、
 * 名前もそこから決める。どの規則にも当たらない添付は無視する（要件どおり）。
 *
 * 移植元: tenmatsu.py 998-1002, 2731-2839
 * ブラウザ側からも使うので、Playwright にも server-only にも依存しない。
 */
import { toAscii } from "./text";

export interface ComposeRules {
  /** これを含む添付があればパターン2（決定通知書だけを使う） */
  decisionPattern: string;
  estimateSummaryPattern: string;
  estimatePattern: string;
  otherPattern: string;
  /** ★結合はしないが、ほかから名前を決められないときに名前の元にする添付 */
  quotePattern: string;
  nameWithDecision: string;
  nameWithoutDecision: string;
}

export const DEFAULT_COMPOSE: ComposeRules = {
  decisionPattern: "決定通知書",
  estimateSummaryPattern: "^見積総覧",
  estimatePattern: "^見積[：:]",
  otherPattern: "写真",
  quotePattern: "^御見積書",
  nameWithDecision: "保険金請求書（{paren}）",
  nameWithoutDecision: "御見積書（{paren}）",
};

export type ComposeGroup = "decision" | "summary" | "estimate" | "other";
/** 名前に使う括弧の中身を、どこから取れたか */
export type ParenFrom = "decision" | "summary" | "estimate" | "quote" | null;

export interface ComposePlan {
  pattern: 1 | 2;
  picked: { name: string; group: ComposeGroup }[];
  paren: string | null;
  parenFrom: ParenFrom;
}

/** 名前の中の「（…）」または「(…)」。最初に出てくるもの */
const PAREN_RE = /[（(]([^（()）]*)[）)]/;

/** 名前の中の最初の括弧の中身。無ければ（空でも）null */
export function firstParen(name: string | null | undefined): string | null {
  const m = PAREN_RE.exec(String(name ?? ""));
  if (!m) return null;
  return m[1].trim() || null;
}

/**
 * 伝票No.の下4桁。数字が4桁以上あれば数字の末尾4桁、無ければ文字列の末尾4文字。
 * `TE00001476` → `1476`。
 */
export function last4(denpyoNo: string): string {
  const digits = toAscii(denpyoNo).replace(/\D/g, "");
  const src = digits.length >= 4 ? digits : denpyoNo;
  return src.slice(-4);
}

/**
 * 専決決裁書の添付から、捺印決裁書に結合するものを選んで並べる。
 *
 * - パターン2（決定通知書がある）… 決定通知書の先頭1件だけ。名前はその括弧から
 * - パターン1（無い）… 見積総覧 → 見積： → 写真 の順。
 *   名前は見積総覧の括弧、無ければ「見積：」の後ろ（拡張子を除く）
 * - どちらでも名前が決まらなければ「御見積書（〇〇）」から取る。★ただし**結合はしない**
 */
export function composeNatsuinParts(
  names: readonly string[],
  rules: Partial<ComposeRules> = {},
): ComposePlan {
  const cfg = { ...DEFAULT_COMPOSE, ...rules };
  const matches = (pattern: string) => {
    const re = new RegExp(pattern);
    return (n: string) => re.test(n);
  };

  const withQuote = (result: ComposePlan): ComposePlan => {
    if (result.paren) return result;
    const isQuote = matches(cfg.quotePattern);
    for (const name of names) {
      if (!isQuote(name)) continue;
      const got = firstParen(name);
      if (got) return { ...result, paren: got, parenFrom: "quote" };
    }
    return result;
  };

  const decision = names.filter(matches(cfg.decisionPattern));
  if (decision.length > 0) {
    return withQuote({
      pattern: 2,
      picked: [{ name: decision[0], group: "decision" }],
      paren: firstParen(decision[0]),
      parenFrom: "decision",
    });
  }

  const summary = names.filter(matches(cfg.estimateSummaryPattern));
  const isEstimate = matches(cfg.estimatePattern);
  const estimate = names.filter((n) => !summary.includes(n) && isEstimate(n));
  const isOther = matches(cfg.otherPattern);
  const other = names.filter((n) => !summary.includes(n) && !estimate.includes(n) && isOther(n));

  const picked: ComposePlan["picked"] = [
    ...summary.map((name) => ({ name, group: "summary" as const })),
    ...estimate.map((name) => ({ name, group: "estimate" as const })),
    ...other.map((name) => ({ name, group: "other" as const })),
  ];

  let paren = summary.length > 0 ? firstParen(summary[0]) : null;
  let parenFrom: ParenFrom = paren ? "summary" : null;
  if (!paren && estimate.length > 0) {
    // 「見積：〇〇.pdf」→「〇〇」。コロンの後ろ全部から拡張子を落とす。
    // ★拡張子の切り落としに path の stem を使わない。「.pdf」だけの名前を「.pdf」と返してしまう
    const at = estimate[0].search(/[：:]/);
    const tail = at >= 0 ? estimate[0].slice(at + 1) : null;
    paren = tail !== null ? tail.replace(/\.[^.]+$/, "").trim() || null : null;
    parenFrom = paren ? "estimate" : null;
  }
  return withQuote({ pattern: 1, picked, paren, parenFrom });
}

/**
 * 確定したときに付けるファイル名。括弧の中身が取れなければ接頭辞＋下4桁に落とす。
 *
 * ★名前の形は `pattern` ではなく **「どこから括弧の中身を取れたか」** で決まる。
 *   決定通知書から → 保険金請求書（〇〇）.pdf ／ それ以外 → 御見積書（〇〇）.pdf
 * ★接頭辞は必ず渡す（既定値を置かない）。取り違えると別の種類の名前で保存してしまう。
 */
export function natsuinFinalName(
  plan: Pick<ComposePlan, "paren" | "parenFrom">,
  rules: Partial<ComposeRules>,
  denpyoNo: string,
  prefix: string,
): string {
  const cfg = { ...DEFAULT_COMPOSE, ...rules };
  const paren = plan.paren;
  if (paren) {
    const template = plan.parenFrom === "decision" ? cfg.nameWithDecision : cfg.nameWithoutDecision;
    // ★置換を関数で渡す。文字列で渡すと、括弧の中身に `$&` などがあったとき名前が化ける
    return `${template.replace("{paren}", () => paren)}.pdf`;
  }
  return `${prefix}${last4(denpyoNo)}.pdf`;
}
