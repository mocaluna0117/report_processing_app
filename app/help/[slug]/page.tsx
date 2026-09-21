import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Shots } from "@/app/help/_shots";
import { HELP_SECTIONS } from "@/lib/help";

/**
 * 1画面ぶんの「使い方」。手順・写真・よくあるつまずきをまとめる。
 *
 * ★5画面ぶんを1ページに並べていたら「全部の使い方が一度に出て見づらい」と言われたので、
 *   画面ごとにページを分けた（2026-09-22）。中身は lib/help.ts の HelpSection そのまま。
 */

export function generateStaticParams() {
  return HELP_SECTIONS.map((section) => ({ slug: section.slug }));
}

function findSection(slug: string) {
  return HELP_SECTIONS.find((section) => section.slug === slug);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const section = findSection((await params).slug);
  return { title: section ? `Folio — 使い方 — ${section.title}` : "Folio — 使い方" };
}

export default async function HelpSectionPage({ params }: { params: Promise<{ slug: string }> }) {
  const section = findSection((await params).slug);
  if (!section) notFound();

  return (
    <main>
      <nav aria-label="パンくず" className="mt-4 text-sm">
        <Link href="/help" className="text-slate-500 underline hover:text-slate-700">
          使い方
        </Link>
        <span className="mx-1 text-slate-400">/</span>
        <span className="text-slate-700">{section.title}</span>
      </nav>

      {/* ★他の画面の使い方へすぐ移れるように（元の1ページ版にあった目次の代わり） */}
      <nav aria-label="ほかの画面の使い方" className="mt-3 flex flex-wrap gap-2 text-sm">
        {HELP_SECTIONS.map((other) => (
          <Link
            key={other.id}
            href={`/help/${other.slug}`}
            aria-current={other.slug === section.slug ? "page" : undefined}
            className={
              other.slug === section.slug
                ? "rounded-md border border-slate-400 bg-white px-2.5 py-1 font-semibold text-slate-900"
                : "rounded-md border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
            }
          >
            {other.title}
          </Link>
        ))}
      </nav>

      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold">{section.title}</h1>
          <Link href={section.href} className="text-sm text-blue-700 underline hover:text-blue-900">
            この画面を開く
          </Link>
        </div>
        <p className="mt-1 text-sm text-slate-600">{section.intro}</p>

        <h2 className="mt-3 text-sm font-semibold text-slate-800">進め方</h2>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-700">
          {section.steps.map((step) => (
            <li key={step.id}>
              <span className="font-medium">{step.label}</span>
              {" — "}
              {step.description}
            </li>
          ))}
        </ol>

        <Shots section={section} />

        <h2 className="mt-3 text-sm font-semibold text-slate-800">よくあるつまずき</h2>
        <dl className="mt-1 space-y-2 text-sm">
          {section.faq.map((item) => (
            <div key={item.q}>
              <dt className="font-medium text-slate-800">{item.q}</dt>
              <dd className="text-slate-600">{item.a}</dd>
            </div>
          ))}
        </dl>
      </div>

      <p className="mt-6 text-sm">
        <Link href="/help#help-common" className="text-blue-700 underline hover:text-blue-900">
          どの画面でも共通のつまずきを見る
        </Link>
      </p>
    </main>
  );
}
