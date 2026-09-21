"use client";

// ヘッダーの「Folio」の横に、いま開いている画面の名前を出す。
// タブと同じ MODES を引くので、画面が増えてもここは直さなくてよい。
import { usePathname } from "next/navigation";
import { MODES } from "@/components/mode-nav";

/** タブに出さない画面の名前（ヘッダーの「使い方」など） */
const EXTRA_TITLES: Readonly<Record<string, string>> = { "/help": "使い方" };

export function PageTitle() {
  const pathname = usePathname();
  const mode = MODES.find((m) => m.href === pathname);
  return (
    <span className="ml-3 align-middle text-sm font-normal text-slate-500">
      {/* ログイン画面や知らないURLでは、今までどおりアプリの説明を出す */}
      {mode?.label ?? EXTRA_TITLES[pathname] ?? "報告書処理"}
    </span>
  );
}
