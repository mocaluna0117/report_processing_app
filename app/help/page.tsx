import type { Metadata } from "next";
import Link from "next/link";
import { COMMON_FAQ, HELP_SECTIONS, type HelpSection } from "@/lib/help";
import { HELP_SHOT_GEOMETRY } from "@/lib/help-shots.generated";
import { SHOT_SCALE, helpShotSrc } from "@/lib/help-shots";

/**
 * 「使い方」ページ。各画面の手順と、よくあるつまずきをまとめる。
 *
 * ★手順の文言は各画面の規則（lib/*flow*.ts）から持ってくるので、画面の手順バーとずれない。
 * ★README は開発者向けなので、利用者にはこのページを見てもらう。
 * ★**写真は next/image を使わず、素の <img src="/help/…"> で出す。**
 *   proxy.ts の matcher は /_next/image と /_next/static を認証の対象外にしているので、
 *   next/image や静的インポートで出すと、社内画面の写真が APP_PASSWORD の外に置かれる。
 *   （tests/help.test.ts が、この決まりが戻されていないか見張っている）
 */
export const metadata: Metadata = {
  title: "Folio — 使い方",
};

const SECTION_CLASS = "mt-6 scroll-mt-4 rounded-lg border border-slate-200 bg-white p-4";
/** 画像に重ねる番号の印。手順バーの段の印（components/flow-steps.tsx）と同じ見た目にそろえる */
const MARKER_CLASS =
  "absolute z-10 inline-flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center " +
  "rounded-full bg-blue-600 text-xs font-semibold text-white shadow ring-2 ring-white";

/**
 * 画面の写真。印は**飾り（aria-hidden）**で、意味は下の番号付きの説明が持つ。
 * 押せる印にすると「押しても何も起きない」罠になるので、押せるようにしない。
 */
function Shots({ section }: { section: HelpSection }) {
  const shots = section.shots.filter((shot) => HELP_SHOT_GEOMETRY[shot.id]);
  if (shots.length === 0) return null;
  return (
    <>
      <h3 className="mt-3 text-sm font-semibold text-slate-800">画面の写真</h3>
      {shots.map((shot) => {
        const geometry = HELP_SHOT_GEOMETRY[shot.id];
        return (
          <figure key={shot.id} className="mt-2">
            <div
              className="relative overflow-hidden rounded-md border border-slate-200 bg-white"
              style={{ maxWidth: `${Math.round(geometry.width / SHOT_SCALE)}px` }}
            >
              <img
                src={helpShotSrc(shot)}
                alt={shot.alt}
                width={geometry.width}
                height={geometry.height}
                loading="lazy"
                decoding="async"
                className="block h-auto w-full"
              />
              {geometry.hotspots.map((at, i) => (
                <span
                  key={shot.hotspots[i]?.text ?? i}
                  aria-hidden
                  className={MARKER_CLASS}
                  style={{ left: `${at.x}%`, top: `${at.y}%` }}
                >
                  {i + 1}
                </span>
              ))}
            </div>
            <figcaption className="mt-1 text-sm text-slate-600">
              {shot.caption}
              <a
                href={helpShotSrc(shot)}
                target="_blank"
                rel="noreferrer"
                className="ml-2 text-xs text-blue-700 underline hover:text-blue-900"
              >
                大きく見る
              </a>
              {shot.hotspots.length > 0 && (
                <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-slate-700">
                  {shot.hotspots.map((hotspot) => (
                    <li key={hotspot.text}>{hotspot.text}</li>
                  ))}
                </ol>
              )}
            </figcaption>
          </figure>
        );
      })}
    </>
  );
}

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

          <Shots section={section} />

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
