/**
 * 一覧の行の判定と、読み終えたときの言い方。
 *
 * 移植元: tenmatsu.py 3098-3106, 3316-3336
 * ブラウザ側からも使うので、Playwright にも server-only にも依存しない。
 */

/**
 * 状態が「最終承認済み」か。
 *
 * ★**部分一致で見る**。設定の値は「承認済」だが、実画面は「**承認済み**」（送り仮名あり）。
 *   完全一致にすると**1件も拾えなかった**（実バグ）。件数などが後ろに付く場合もある。
 *   「承認済」は「承認依頼中 0/3」「取下げ」「差戻し」には含まれないので誤検出しない。
 *
 * ※移植元は空の値を渡すと全件を承認済みとみなしていた（空文字はどの文字列にも含まれるため）。
 *   ここでは空の値を無視する。
 */
export function isApproved(status: string, approvedValues: readonly string[]): boolean {
  const s = (status ?? "").trim();
  return approvedValues
    .map((v) => v.trim())
    .filter(Boolean)
    .some((v) => s.includes(v));
}

export interface ScanOutcome {
  /** 最終ページに届く前に読むのをやめたか */
  stoppedEarly: boolean;
  total: number | null;
  last: number | null;
  scanned: number;
  reason: string | null;
}

/**
 * 対象が0件だったときに出す1行。**なぜ0件なのかが分かる言い方**にする。
 *
 * ★「対象が無かった」と「最後まで読めなかった」を**混ぜない**。混ぜると、ページ送りが
 *   効かないだけなのに「新規対象はありません」と言ってしまう（実際に起きた）。
 *
 * ※移植元は直し方として Python の設定ファイルと inspect コマンドを案内していた。
 *   Folio では利用者がそれらを触れないので、取り直しと、続くときの見立てを案内する。
 */
export function scanSummary(scan: ScanOutcome, label: string): string {
  const { total, last, scanned } = scan;
  if (!scan.stoppedEarly) {
    return total !== null
      ? `新規対象はありません（${total}件すべてを確認しました）。`
      : `新規対象はありません（${scanned}行を確認しました）。`;
  }
  const readTo = last ?? scanned;
  const where = total !== null ? `${total}件中 ${readTo}件目まで` : `${readTo}行まで`;
  return (
    `! ${where}しか読めませんでした（${scan.reason || "理由不明"}）。` +
    `この先に未取得の${label}が残っている可能性があります。` +
    "もう一度取得してください。何度やっても同じ所で止まるときは、楽楽精算の画面が変わった可能性があります。"
  );
}
