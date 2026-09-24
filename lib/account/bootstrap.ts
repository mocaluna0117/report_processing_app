/**
 * 最初の管理者を作るためのコード（FOLIO_BOOTSTRAP）。
 *
 * 形は `<期限(秒)>:<ログインID>:<コードの scrypt ハッシュ>`。手元のコマンド（scripts/accounts/bootstrap-code.mts）が作る。
 * - コードそのものは env に入れない（ハッシュだけ）。Redis の鍵も手元に要らない
 * - 使えるのは1回だけ（Redis に使った印を置く）。ほかの ID の失敗では使い切られない
 * - 使ったら env から消す。管理者のパスワードを忘れたときは、作り直して入れ直す
 */
import { normalizeLoginId } from "@/lib/account/policy";

export interface Bootstrap {
  expSec: number;
  loginId: string;
  hash: string;
}

const LOGIN_ID = /^[a-z0-9][a-z0-9._-]{2,31}$/;

export function parseBootstrap(value: string | null | undefined): Bootstrap | null {
  if (!value) return null;
  const first = value.indexOf(":");
  const second = value.indexOf(":", first + 1);
  if (first <= 0 || second <= first + 1) return null;
  const expSec = Number(value.slice(0, first));
  const loginId = value.slice(first + 1, second);
  const hash = value.slice(second + 1);
  if (!Number.isSafeInteger(expSec) || expSec <= 0) return null;
  if (!LOGIN_ID.test(loginId) || normalizeLoginId(loginId) !== loginId) return null;
  if (!hash.startsWith("scrypt$")) return null;
  return { expSec, loginId, hash };
}

export function formatBootstrap(b: Bootstrap): string {
  return `${b.expSec}:${b.loginId}:${b.hash}`;
}
