import type { Metadata } from "next";
import { TenmatsuPage } from "@/components/tenmatsu/tenmatsu-page";
import { SENKETSU } from "@/lib/tenmatsu/kinds";

export const metadata: Metadata = {
  title: SENKETSU.pageTitle,
  description: SENKETSU.pageDescription,
};

export default function Page() {
  return <TenmatsuPage kind="senketsu" />;
}
