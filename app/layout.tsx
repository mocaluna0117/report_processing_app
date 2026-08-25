import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "報告書処理",
  description:
    "写真報告書・点検報告書のPDF結合とExcel転記用テキスト抽出 (ローカル処理)",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body className="min-h-screen bg-slate-100 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
