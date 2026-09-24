/**
 * 別のサイトから送られてきた POST かどうか（ログイン・ログアウト・パスワード変更・管理）。純関数。
 *
 * ★人ごとのアカウントでは、他人のサイトに置いたフォームから「攻撃者の ID でログインさせる」ことができる
 *   （login CSRF）。そのため、同じサイトから送られたと確かめられないものは断る（fail closed）。
 * ★`Origin: null`（プライバシーの設定などで起きる）でも例外を出さない。
 *   lib/rakuraku/guard.ts の assertSameOrigin は new URL("null") で例外になるので、こちらは使い回さない。
 */
export interface OriginInput {
  /** リクエストの URL（request.url） */
  url: string;
  /** Sec-Fetch-Site ヘッダー（無ければ null） */
  fetchSite: string | null;
  /** Origin ヘッダー（無ければ null） */
  origin: string | null;
}

export function isSameOriginPost({ url, fetchSite, origin }: OriginInput): boolean {
  // 今のブラウザ（Chrome・Edge）は必ず付ける。付いていれば、それだけで決める
  if (fetchSite !== null) return fetchSite === "same-origin";
  if (origin === null || origin === "null") return false;
  try {
    return new URL(origin).origin === new URL(url).origin;
  } catch {
    return false;
  }
}

/** Request から読む */
export function originInputOf(request: Request): OriginInput {
  return {
    url: request.url,
    fetchSite: request.headers.get("sec-fetch-site"),
    origin: request.headers.get("origin"),
  };
}
