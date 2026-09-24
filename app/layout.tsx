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
          {/* ★1段目は見出しと、右端の人の形のアイコン（アカウント・ログアウト）。
              2段目に画面のタブとボタン（見出しの1段下。利用者の希望 2026-09-24） */}
          <header>
            <div className="flex items-center justify-between gap-4">
              <h1 className="text-2xl font-bold tracking-tight">
                Folio
                <PageTitle />
              </h1>
              <AccountMenu />
            </div>
            <div className="mt-3">
              <ModeNav />
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
