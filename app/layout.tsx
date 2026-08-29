import type { Metadata } from "next";
import { ModeNav } from "@/components/mode-nav";
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
          <header className="flex flex-wrap items-center justify-between gap-4">
            <h1 className="text-2xl font-bold tracking-tight">
              Folio
              <span className="ml-3 align-middle text-sm font-normal text-slate-500">
                報告書処理
              </span>
            </h1>
            <ModeNav />
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
