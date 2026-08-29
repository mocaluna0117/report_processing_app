import type { Metadata } from "next";
import { AfterPage } from "@/components/after/after-page";

export const metadata: Metadata = {
  title: "Folio — アフターメンテナンス",
  description: "アフターメンテナンス受付 (顧客データの検索・受付内容の要約・完了報告書の作成)",
};

export default function Page() {
  return <AfterPage />;
}
