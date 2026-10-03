import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
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
          {/* ★見出し・画面のタブとボタン・右上のアカウント。入りきるときだけ1段に並べる（components/site-header.tsx） */}
          <SiteHeader />
          {children}
        </div>
      </body>
    </html>
  );
}
