import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { ShishutsuPage } from "@/components/shishutsu/shishutsu-page";
import { accountPageState } from "@/lib/account/page-state";
import { accountStoreFor, currentAuthConfig } from "@/lib/account/runtime";
import { SESSION_COOKIE } from "@/lib/auth";
import { canUseExpenseReport } from "@/lib/shishutsu/access";

export const metadata: Metadata = {
  title: "Folio — 支出報告書",
  description: "進捗管理表と顛末書から、月ごとの支出報告書 (Excel) を作る",
};
export const dynamic = "force-dynamic";

const NOTICE = "mt-8 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600";

/**
 * 支出報告書（決まったアカウントだけ。lib/shishutsu/access.ts）。
 * ★印の中身だけを信じず、Redis で「今もそのアカウントで、止められていない」ことを確かめてから画面を出す。
 * ★読み込む表・顛末書の記録はブラウザの中だけで扱う（サーバーへは送らない）。
 */
export default async function Page() {
  const config = currentAuthConfig();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const state = await accountPageState(config, token, accountStoreFor, Math.floor(Date.now() / 1000));

  // 手元の開発（一人ずつのアカウントを使っていない）では、そのまま使える
  // ★設定が壊れている（broken）ときは unavailable になる。ここで通さない
  if (state.kind === "off") return <ShishutsuPage />;
  if (state.kind === "expired") {
    return (
      <p className={NOTICE}>
        ログインが切れました。
        <Link href="/login?next=%2Fshishutsu" className="ml-1 font-medium text-blue-700 underline">
          もう一度ログイン
        </Link>
        してください。
      </p>
    );
  }
  if (state.kind === "unavailable") {
    return <p className={NOTICE}>いまアカウントの置き場所に届きません。少し待ってから読み込み直してください。</p>;
  }
  if (!canUseExpenseReport(state.record.id) || state.forced) {
    return <p className={NOTICE}>この画面は使えません。</p>;
  }
  return <ShishutsuPage />;
}
