"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { HelpShots } from "@/components/help-shots";
import { ModalShell } from "@/components/modal-shell";
import { COMMON_FAQ, HELP_SECTIONS } from "@/lib/help";
import { closeHelp, getHelpDialogState, subscribeHelpDialog } from "@/lib/help-dialog";
import { getNavigationGuard } from "@/lib/navigation-guard";

/** 「どの画面でも」タブの目印（HELP_SECTIONS の slug とはぶつからない） */
const COMMON_TAB = "__common__";

/**
 * ★前は「枠線が少し濃い＋太字」だけの違いで、選んでいるタブが分かりにくかった。
 *   ヘッダーの画面タブ（components/mode-nav.tsx の MODES）と同じ
 *   「グレーの帯の上に、選んだものだけ白いピル」にして、はっきり見分けられるようにする。
 */
const TAB_TRACK_CLASS = "inline-flex flex-wrap gap-1 rounded-lg bg-slate-200 p-1 shadow-inner";
const TAB_CLASS = (active: boolean) =>
  active
    ? "rounded-md bg-white px-2.5 py-1 text-sm font-semibold text-slate-900 shadow-sm"
    : "cursor-pointer rounded-md px-2.5 py-1 text-sm font-medium text-slate-600 hover:text-slate-900";

/**
 * 「使い方」をモーダルで表示する。
 *
 * ★以前は /help・/help/<slug> の別ページだったが、「画面を切り替えずに見たい」
 *   という理由でモーダルに変えた（2026-09-22）。中身（lib/help.ts）は変えていない。
 * ★どこからでも開けるよう、ヘッダー（components/mode-nav.tsx）に一度だけ置く。
 *   開閉は lib/help-dialog.ts のモジュール状態で共有する。
 */
export function HelpDialog() {
  const [state, setState] = useState(getHelpDialogState);
  useEffect(() => subscribeHelpDialog(setState), []);

  // 開くたびに選んでおく画面を決める（毎回 render するとタブを切り替えても閉じるまで保つ）
  const [tab, setTab] = useState(state.slug ?? HELP_SECTIONS[0].slug);
  useEffect(() => {
    if (state.open) setTab(state.slug ?? HELP_SECTIONS[0].slug);
    // ★開いた瞬間だけ選び直す。開いている間にタブを押しても、この effect で戻さない
    // biome-ignore lint/correctness/useExhaustiveDependencies: state.open が変わったときだけ見る
  }, [state.open]);

  if (!state.open) return null;

  const section = tab === COMMON_TAB ? null : HELP_SECTIONS.find((s) => s.slug === tab);

  return (
    <ModalShell
      label="使い方"
      onClose={closeHelp}
      // ★max-h ではなく h にする。タブによって中身の長さが違う（「どの画面でも」は特に短い）ので、
      //   max-h だと切り替えるたびにモーダルの大きさが変わって見にくかった。高さを固定し、
      //   中身が短いタブは下に余白ができるだけにする（中身が長いタブは今までどおり中で縦スクロール）
      panelClassName="flex h-[85vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-xl"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <h2 className="text-xl font-bold text-slate-900">使い方</h2>
        <button
          type="button"
          onClick={closeHelp}
          aria-label="閉じる"
          className="cursor-pointer rounded-md px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          ✕
        </button>
      </div>

      <nav aria-label="画面を選ぶ" className="border-b border-slate-200 px-5 py-3">
        <div className={TAB_TRACK_CLASS}>
          {HELP_SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setTab(s.slug)}
              aria-current={tab === s.slug ? "page" : undefined}
              className={TAB_CLASS(tab === s.slug)}
            >
              {s.title}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setTab(COMMON_TAB)}
            aria-current={tab === COMMON_TAB ? "page" : undefined}
            className={TAB_CLASS(tab === COMMON_TAB)}
          >
            どの画面でも
          </button>
        </div>
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {section ? (
          <>
            {/* ★選んでいる画面の名前を、タブとは別に本文の先頭にも大きく出す
                （タブの印だけでは、今どの画面を見ているか見落としやすかった） */}
            <h3 className="text-xl font-bold text-slate-900">{section.title}</h3>
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="text-base leading-relaxed text-slate-600">{section.intro}</p>
              <Link
                href={section.href}
                onNavigate={(e) => {
                  // ★処理中に別の画面へ移ると、その分をやり直すことになる（他のタブ切り替えと同じ確認）。
                  //   onNavigate は onClick のあとに呼ばれるので、閉じるのはここでだけ行う
                  //   （閉じたあとに確認で「移らない」を選ぶと、直せない画面が消えたままになる）
                  const guard = getNavigationGuard();
                  if (guard && !confirm(guard)) {
                    e.preventDefault();
                    return;
                  }
                  closeHelp();
                }}
                className="whitespace-nowrap text-sm font-medium text-blue-700 underline hover:text-blue-900"
              >
                この画面を開く
              </Link>
            </div>

            <h4 className="mt-6 text-base font-semibold text-slate-900">進め方</h4>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-slate-700">
              {section.steps.map((step) => (
                <li key={step.id}>
                  <span className="font-semibold text-slate-900">{step.label}</span>
                  {" — "}
                  {step.description}
                </li>
              ))}
            </ol>

            <HelpShots section={section} />

            <h4 className="mt-6 text-base font-semibold text-slate-900">よくあるつまずき</h4>
            <dl className="mt-2 space-y-3 text-sm">
              {section.faq.map((item) => (
                <div key={item.q}>
                  <dt className="font-semibold text-slate-900">{item.q}</dt>
                  <dd className="mt-0.5 leading-relaxed text-slate-600">{item.a}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <>
            <h3 className="text-xl font-bold text-slate-900">どの画面でも</h3>
            <dl className="mt-4 space-y-3 text-sm">
              {COMMON_FAQ.map((item) => (
                <div key={item.q}>
                  <dt className="font-semibold text-slate-900">{item.q}</dt>
                  <dd className="mt-0.5 leading-relaxed text-slate-600">{item.a}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
    </ModalShell>
  );
}
