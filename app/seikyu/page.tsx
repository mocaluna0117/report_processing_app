import type { Metadata } from "next";
import { TenmatsuPage } from "@/components/tenmatsu/tenmatsu-page";
import { SEIKYU } from "@/lib/tenmatsu/kinds";

export const metadata: Metadata = {
  title: SEIKYU.pageTitle,
  description: SEIKYU.pageDescription,
};

export default function Page() {
  return <TenmatsuPage kind="seikyu" />;
}
