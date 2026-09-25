import type { Metadata } from "next";
import { AccountMenu } from "@/components/account-menu";
import { ModeNav } from "@/components/mode-nav";
import { PageTitle } from "@/components/page-title";
import "./globals.css";

export const metadata: Metadata = {
  title: "Folio",
  description:
    "Folio — 報告書のPDF結合・Excel転記用テキスト抽出・完了報告書作成 (ローカル処理)",
};

/**
 * ヘッダーの並べ方（2026-09-25 に利用者の試しで1段にした）。
 * - true: 画面が広いとき（1240px 以上）は「見出し・タブとボタン（中央）・右上のアイコン」を1段に並べる。
 *   狭いときは入りきらないので、今までどおり2段（タブとボタンは見出しの1段下）。
 *   いちばん幅の要る「アフターメンテナンス」の画面で約1231px（実測）。万一足りないときは、見出しの画面名を「…」で縮める（重ねない）
 * - false: いつも2段（今までの形）
 * ★元に戻すときは false にするだけ（ほかは変えていない）。
 */
const HEADER_ONE_ROW = true;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-slate-100 text-slate-900 antialiased">
        <div className="mx-auto max-w-7xl px-6 py-8">
          {/* ★1段目は見出しと、右端の人の形のアイコン（アカウント・ログアウト）。
              2段目に画面のタブとボタン（見出しの1段下。利用者の希望 2026-09-24）。
              HEADER_ONE_ROW のときは、広い画面でタブとボタンを1段目の中央へ入れる（CSS の格子で置き場所だけ変える） */}
          {/* ★ヘッダーの下は少し空ける（各画面の最初の説明の文と詰まって見えたため。2026-09-25）。
              ★margin だと各画面の最初の文の mt-4 と重なって（相殺されて）広がらないので、padding で空ける */}
          <header
            className={
              HEADER_ONE_ROW
                ? "pb-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 min-[1240px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
                : "pb-3"
            }
          >
            <div className={HEADER_ONE_ROW ? "contents" : "flex items-center justify-between gap-4"}>
              <h1 className={`text-2xl font-bold tracking-tight ${HEADER_ONE_ROW ? "min-w-0 truncate min-[1240px]:col-start-1 min-[1240px]:row-start-1" : ""}`}>
                Folio
                <PageTitle />
              </h1>
              <div className={HEADER_ONE_ROW ? "justify-self-end min-[1240px]:col-start-3 min-[1240px]:row-start-1" : undefined}>
                <AccountMenu />
              </div>
            </div>
            <div className={HEADER_ONE_ROW ? "col-span-2 min-[1240px]:col-span-1 min-[1240px]:col-start-2 min-[1240px]:row-start-1" : "mt-3"}>
              <ModeNav />
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
