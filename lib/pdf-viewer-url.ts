/**
 * ブラウザに組み込みの PDF 表示（Chrome / Edge）へ渡す URL。
 *
 * ★既定では左にページの一覧（サイドバー、幅 約300px）が出て、モーダルの中では PDF が小さくなっていた
 *   （2026-10-04 利用者の指摘）。一覧を閉じた状態で開き、PDF を幅いっぱいに合わせる。
 *   一覧は PDF 表示の左上の ≡ からいつでも開ける。
 * ★URL の # 以降は PDF 表示が読む指定で、blob: の URL でも効く（2026-10-04 に Chrome で確かめた）。
 */
export function pdfViewerUrl(url: string): string {
  return `${url.split("#")[0]}#navpanes=0&view=FitH`;
}
