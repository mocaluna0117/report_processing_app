import type { Metadata } from "next";
import { TenmatsuPage } from "@/components/tenmatsu/tenmatsu-page";

export const metadata: Metadata = {
  title: "Folio — 顛末書",
  description: "顛末書PDFの取得 (このPCのローカルサーバー経由) と取得済み一覧の確認",
};

export default function Page() {
  return <TenmatsuPage />;
}
