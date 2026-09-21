import { KINDS, routesForAccount } from "@/lib/rakuraku/kinds";
import type { KindId, RouteHow, RouteId, RouteScope } from "@/lib/rakuraku/protocol";

/**
 * 一覧の経路の言い方（画面とログで共用）。純関数のみ。
 *
 * ★どの経路で取ったかは必ず利用者に見せる。経路によって**一覧に出る伝票の範囲が違う**
 *   （申請検索は自分が申請した伝票だけ）ので、黙って切り替えると「取れているつもり」で
 *   抜けが出る。
 */

export interface RouteNotice {
  label: string;
  scope: RouteScope;
  how: RouteHow;
}

/** 取得中・取得後に出す1行 */
export function routeNoticeText(kindLabel: string, notice: RouteNotice): string {
  const head = notice.how === "fallback" ? "閲覧の一覧を開けなかったので、" : "";
  const scope =
    notice.scope === "own" ? "（一覧に出るのは自分が申請した伝票だけです）" : "";
  return `${head}${kindLabel}は「${notice.label}」の一覧から取っています${scope}`;
}

/** 画面の「一覧の経路」の選択肢（その種類にある経路だけ） */
export function routeOptions(kind: KindId): { id: RouteId; label: string; scope: RouteScope }[] {
  return KINDS[kind].routes.map((r) => ({ id: r.id, label: r.label, scope: r.scope }));
}

/**
 * ログインした時点で分かる「この種類はどの経路から取るか」の1行。
 *
 * ★経路を選ばせる代わりに、決まった結果を伝えるための文（利用者の決定 2026-09-22）。
 *   経路によって一覧に出る範囲が変わるので、**自分の申請分だけ**のときは必ずそう書く。
 * ★viewTab が分からない（古いサーバー・古い札）ときは null（何も出さない）。
 */
export function accountRouteText(kind: KindId, viewTab: boolean | null): string | null {
  if (viewTab === null) return null;
  const doc = KINDS[kind];
  const route = routesForAccount(doc, viewTab)[0];
  const tab = viewTab ? "「閲覧」タブがあるので" : "「閲覧」タブが無いので";
  const scope = route.scope === "own" ? `（一覧に出るのは自分が申請した${doc.label}だけです）` : "";
  return `このアカウントには${tab}、${doc.label}は「${route.label}」の一覧から取ります${scope}`;
}

/** 選択肢に添える説明（自分が申請した伝票だけ、を必ず添える） */
export function routeOptionLabel(option: { label: string; scope: RouteScope }): string {
  return option.scope === "own" ? `${option.label}・自分の申請分だけ` : option.label;
}
