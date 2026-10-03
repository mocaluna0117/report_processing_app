"use client";

/**
 * 画面のいちばん上（「Folio」と画面名・画面のタブとボタン・右上のアカウント）。
 *
 * ★広い画面では1段に並べる。ただし**入りきるときだけ**。実際の幅を測って、次の順に決める（2026-10-04）:
 *   1. full    … そのまま1段（Folio・画面名・タブとボタン・アカウント）
 *   2. compact … 画面名を隠して1段（選んでいるタブが白く目立つので、画面名は重複している）
 *   3. two     … 2段（1段目に Folio・画面名とアカウント、2段目にタブとボタン）
 *   タブが7つになる人（支出報告書が見える人）や名前の長い人で、右上の共有フォルダーとアカウントが重なった
 *   （画面の最大幅 1232px に対して約1,312px 要った）。
 * ★1240px より狭い画面は CSS だけで2段（測る前の最初の表示も崩れない）。
 * ★HEADER_ONE_ROW を false にすると、いつも2段（今までの形）。
 */
import { useLayoutEffect, useRef, useState } from "react";
import { AccountMenu } from "@/components/account-menu";
import { ModeNav } from "@/components/mode-nav";
import { PageTitle } from "@/components/page-title";

const HEADER_ONE_ROW = true;
/** 1段に並べる最小の画面幅（CSS の min-[1240px] と同じ） */
const ONE_ROW_MIN_VIEWPORT = 1240;
/** 列のあいだ（gap-x-4）と、ボタンの段の中のあいだ（gap-3） */
const COLUMN_GAP = 16;
const NAV_GAP = 12;

export type HeaderFit = "full" | "compact" | "two";

/** 測った幅から並べ方を決める（純関数。テストする） */
export function decideHeaderFit(m: {
  viewport: number;
  available: number;
  folio: number;
  title: number;
  nav: number;
  account: number;
}): HeaderFit {
  if (!HEADER_ONE_ROW || m.viewport < ONE_ROW_MIN_VIEWPORT) return "two";
  const rest = m.nav + m.account + COLUMN_GAP * 2;
  if (m.folio + m.title + rest <= m.available) return "full";
  if (m.folio + rest <= m.available) return "compact";
  return "two";
}

/** ボタンの段の、折り返さないときの幅（並んでいる部品の幅の合計＋あいだ） */
function naturalRowWidth(row: Element | null): number {
  if (!row) return 0;
  const kids = Array.from(row.children).filter((c) => c.getBoundingClientRect().width > 0);
  return kids.reduce((sum, c) => sum + c.getBoundingClientRect().width, 0) + NAV_GAP * Math.max(0, kids.length - 1);
}

export function SiteHeader() {
  const [fit, setFit] = useState<HeaderFit>("full");
  const headerRef = useRef<HTMLElement>(null);
  const folioRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const measure = () => {
      const next = decideHeaderFit({
        viewport: window.innerWidth,
        available: header.clientWidth,
        folio: folioRef.current?.getBoundingClientRect().width ?? 0,
        // ★隠しているときも中身の幅は測れる（overflow-hidden の scrollWidth）
        title: titleRef.current?.scrollWidth ?? 0,
        nav: naturalRowWidth(navRef.current?.firstElementChild ?? null),
        account: accountRef.current?.firstElementChild?.getBoundingClientRect().width ?? 0,
      });
      setFit((prev) => (prev === next ? prev : next));
    };
    measure();
    // 画面幅・中身（共有フォルダーの表示の文・アカウントの名前・タブの数）が変わったら測り直す
    const resize = new ResizeObserver(measure);
    resize.observe(header);
    const mutation = new MutationObserver(measure);
    mutation.observe(header, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);

  const one = fit !== "two";
  return (
    // ★ヘッダーの下は少し空ける（各画面の最初の説明の文と詰まって見えたため。2026-09-25）。
    //   margin だと各画面の最初の文の mt-4 と重なって（相殺されて）広がらないので、padding で空ける
    <header
      ref={headerRef}
      data-fit={fit}
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 pb-3 ${
        // ★左右の列は中身の幅より狭くしない（重ならない）。余白があるときは同じ幅＝タブが中央
        one ? "min-[1240px]:grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)]" : ""
      }`}
    >
      <h1 className={`min-w-0 truncate text-2xl font-bold tracking-tight ${one ? "min-[1240px]:col-start-1 min-[1240px]:row-start-1" : ""}`}>
        <span ref={folioRef}>Folio</span>
        <span
          ref={titleRef}
          className={`inline-block overflow-hidden whitespace-nowrap align-middle ${fit === "compact" ? "max-w-0" : ""}`}
        >
          <PageTitle />
        </span>
      </h1>
      <div ref={accountRef} className={`justify-self-end ${one ? "min-[1240px]:col-start-3 min-[1240px]:row-start-1" : ""}`}>
        <AccountMenu />
      </div>
      <div
        ref={navRef}
        className={`col-span-2 ${one ? "min-[1240px]:col-span-1 min-[1240px]:col-start-2 min-[1240px]:row-start-1" : ""}`}
      >
        <ModeNav />
      </div>
    </header>
  );
}
