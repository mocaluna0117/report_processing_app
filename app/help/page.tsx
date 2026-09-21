import type { Metadata } from "next";
import Link from "next/link";
import { COMMON_FAQ, HELP_SECTIONS } from "@/lib/help";

/**
 * 「使い方」ページ。各画面の手順と、よくあるつまずきをまとめる。
 *
 * ★手順の文言は各画面の規則（lib/*flow*.ts）から持ってくるので、画面の手順バーとずれない。
 * ★README は開発者向けなので、利用者にはこのページを見てもらう。
 */
export const metadata: Metadata = {
  title: "Folio — 使い方",
};

const SECTION_CLASS = "mt-6 scroll-mt-4 rounded-lg border border-slate-200 bg-white p-4";

export default function HelpPage() {
  return (
    <main>
      <p className="mt-4 text-sm text-slate-600">
        各画面の進め方と、よくあるつまずきをまとめました。画面の上の手順バーの「使い方を見る」からも開けます。
      </p>

      <nav aria-label="目次" className="mt-4 flex flex-wrap gap-2 text-sm">
        {HELP_SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
          >
            {section.title}
          </a>
        ))}
        <a
          href="#help-common"
          className="rounded-md border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
        >
          どの画面でも
        </a>
      </nav>

      {HELP_SECTIONS.map((section) => (
        <section key={section.id} id={section.id} className={SECTION_CLASS}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">{section.title}</h2>
            <Link href={section.href} className="text-sm text-blue-700 underline hover:text-blue-900">
              この画面を開く
            </Link>
          </div>
          <p className="mt-1 text-sm text-slate-600">{section.intro}</p>

          <h3 className="mt-3 text-sm font-semibold text-slate-800">進め方</h3>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-700">
            {section.steps.map((step) => (
              <li key={step.id}>
                <span className="font-medium">{step.label}</span>
                {" — "}
                {step.description}
              </li>
            ))}
          </ol>

          <h3 className="mt-3 text-sm font-semibold text-slate-800">よくあるつまずき</h3>
          <dl className="mt-1 space-y-2 text-sm">
            {section.faq.map((item) => (
              <div key={item.q}>
                <dt className="font-medium text-slate-800">{item.q}</dt>
                <dd className="text-slate-600">{item.a}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}

      <section id="help-common" className={SECTION_CLASS}>
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
