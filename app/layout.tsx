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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-slate-100 text-slate-900 antialiased">
        <div className="mx-auto max-w-7xl px-6 py-8">
          {/* ★右端は人の形のアイコン（アカウント・ログアウト）。見出しと同じ行に置き、タブが折り返しても動かさない */}
          <header className="flex items-start gap-4">
            <h1 className="shrink-0 pt-1 text-2xl font-bold tracking-tight">
              Folio
              <PageTitle />
            </h1>
            <div className="flex min-w-0 flex-1 justify-end">
              <ModeNav />
            </div>
            <AccountMenu />
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
