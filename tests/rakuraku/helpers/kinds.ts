import { type ListRoute, type RakurakuKind, type ResolvedKind, resolveKind } from "@/lib/rakuraku/kinds";

/**
 * 検証用に、種類の設定から「経路が1つだけの種類」を作る。
 * ★本物の設定（KINDS）を土台にするので、実画面の目印や列の見出しはそのまま使われる。
 */
export function oneRoute(base: RakurakuKind, patch: Partial<ListRoute> = {}): RakurakuKind {
  return { ...base, routes: [{ ...base.routes[0], ...patch }] };
}

/** 経路をいくつか並べた種類（先頭から順に試される） */
export function withRoutes(base: RakurakuKind, patches: Partial<ListRoute>[]): RakurakuKind {
  return {
    ...base,
    routes: patches.map((patch, i) => ({ ...(base.routes[i] ?? base.routes[0]), ...patch })),
  };
}

/** 経路を1つに決めた種類（一覧の行・伝票画面を読む関数へ渡すもの） */
export function resolved(base: RakurakuKind, patch: Partial<ListRoute> = {}): ResolvedKind {
  const kind = oneRoute(base, patch);
  return resolveKind(kind, kind.routes[0]);
}
