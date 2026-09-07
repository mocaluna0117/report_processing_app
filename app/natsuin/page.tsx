import type { Metadata } from "next";
import { TenmatsuPage } from "@/components/tenmatsu/tenmatsu-page";
import { NATSUIN } from "@/lib/tenmatsu/kinds";

export const metadata: Metadata = {
  title: NATSUIN.pageTitle,
  description: NATSUIN.pageDescription,
};

export default function Page() {
  return <TenmatsuPage kind="natsuin" />;
}
