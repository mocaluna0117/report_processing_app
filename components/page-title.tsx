"use client";

// ヘッダーの「Folio」の横に、いま開いている画面の名前を出す。
// タブと同じ MODES を引くので、画面が増えてもここは直さなくてよい。
import { usePathname } from "next/navigation";
import { MODES } from "@/components/mode-nav";
import { HELP_SECTIONS } from "@/lib/help";

function titleFor(pathname: string): string {
  const mode = MODES.find((m) => m.href === pathname);
  if (mode) return mode.label;
  // /help/<slug> はその画面の名前を添える（例: 使い方 — 定期点検）
  if (pathname.startsWith("/help/")) {
    const slug = pathname.slice("/help/".length);
    const section = HELP_SECTIONS.find((s) => s.slug === slug);
    if (section) return `使い方 — ${section.title}`;
  }
  if (pathname === "/help") return "使い方";
  // ログイン画面や知らないURLでは、今までどおりアプリの説明を出す
  return "報告書処理";
}

export function PageTitle() {
  const pathname = usePathname();
  return <span className="ml-3 align-middle text-sm font-normal text-slate-500">{titleFor(pathname)}</span>;
}
