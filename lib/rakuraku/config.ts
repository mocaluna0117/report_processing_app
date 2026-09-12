import "server-only";

/**
 * 楽楽精算のテナント設定。
 *
 * ★ URL は**コードに書かない**。会社ごとの情報なので環境変数から読む。
 *   公開リポジトリなので、テナントの URL や利用者IDが混ざらないようにする。
 * ★ 値は Vercel の **Production スコープだけ**に入れる。Preview には入れない
 *   （プレビュー環境が本番の楽楽精算を触らないようにするため）。
 */
export interface TenantConfig {
  /** ログイン画面の URL。一覧などの URL はここを基点に組む */
  loginUrl: string;
}
// ★部門名は持たない。アカウントによって選べる部門が違うので、その都度楽楽精算から読む
//   （lib/rakuraku/department.ts）。

export function readTenantConfig(): TenantConfig | null {
  const loginUrl = process.env.RAKURAKU_LOGIN_URL?.trim();
  if (!loginUrl) return null;
  try {
    const url = new URL(loginUrl);
    if (url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { loginUrl };
}

/**
 * テナントの中の相対パス（例: `sapWorkflowJibumonKensaku/initializeView?workflowId=4`）を
 * 絶対 URL にする。基点はログイン画面の URL（末尾の `/` までがテナントの場所）。
 */
export function resolveTenantPath(path: string, tenant: TenantConfig): string {
  return new URL(path, tenant.loginUrl).toString();
}

/**
 * ブラウザから渡された URL が、テナントと同じ場所を指しているかを確かめる。
 *
 * ★ 伝票の href や別窓で開いた URL はブラウザ経由で戻ってくるので、
 *   そのまま goto すると任意の場所へ行かされる (SSRF)。必ずここを通す。
 */
export function assertTenantUrl(candidate: string, tenant: TenantConfig): URL {
  const base = new URL(tenant.loginUrl);
  const url = new URL(candidate, base);
  if (url.origin !== base.origin) {
    throw new Error("テナント外のURLは開けません");
  }
  return url;
}
