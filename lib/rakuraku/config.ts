import "server-only";

/**
 * 楽楽精算のテナント設定。
 *
 * ★ URL も部門名も**コードに書かない**。会社ごとの情報なので環境変数から読む。
 *   公開リポジトリなので、テナントの URL や利用者IDが混ざらないようにする。
 * ★ 値は Vercel の **Production スコープだけ**に入れる。Preview には入れない
 *   （プレビュー環境が本番の楽楽精算を触らないようにするため）。
 */
export interface TenantConfig {
  /** ログイン画面の URL。一覧などの URL はここを基点に組む */
  loginUrl: string;
  /** 一覧で選ぶ部門名（現行 config.json の dept_name） */
  deptName: string;
}

export function readTenantConfig(): TenantConfig | null {
  const loginUrl = process.env.RAKURAKU_LOGIN_URL?.trim();
  if (!loginUrl) return null;
  try {
    const url = new URL(loginUrl);
    if (url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { loginUrl, deptName: process.env.RAKURAKU_DEPT_NAME?.trim() ?? "" };
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
