import type { Metadata } from "next";
import Link from "next/link";
import { COMMON_FAQ, HELP_SECTIONS } from "@/lib/help";

/**
 * 「使い方」の入口。画面ごとのページ（/help/<slug>）への一覧と、どの画面でも共通のつまずきをまとめる。
 *
 * ★以前は5画面ぶんを1ページに並べていたが「全部いっぺんに出て見づらい」と言われたので、
 *   画面ごとに分けた（2026-09-22）。各画面の中身は app/help/[slug]/page.tsx。
 */
export const metadata: Metadata = {
  title: "Folio — 使い方",
};

export default function HelpPage() {
  return (
    <main>
      <p className="mt-4 text-sm text-slate-600">
        画面を選ぶと、その進め方と、よくあるつまずきが見られます。画面の上の手順バーの「使い方を見る」からも開けます。
      </p>

      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {HELP_SECTIONS.map((section) => (
          <li key={section.id}>
            <Link
              href={`/help/${section.slug}`}
              className="block h-full rounded-lg border border-slate-200 bg-white p-4 hover:border-blue-300 hover:bg-slate-50"
            >
              <h2 className="font-semibold text-slate-900">{section.title}</h2>
              <p className="mt-1 text-sm text-slate-600">{section.intro}</p>
            </Link>
          </li>
        ))}
      </ul>

      <section id="help-common" className="mt-6 scroll-mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="text-lg font-semibold">どの画面でも</h2>
        <dl className="mt-2 space-y-2 text-sm">
          {COMMON_FAQ.map((item) => (
            <div key={item.q}>
              <dt className="font-medium text-slate-800">{item.q}</dt>
              <dd className="text-slate-600">{item.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <footer className="mt-8 text-xs text-slate-500">
        わからないことがあれば、画面の名前と出ている文面を添えて担当者へ連絡してください。
      </footer>
    </main>
  );
}
