/**
 * 最初の管理者を作るためのコードを、手元で作る（Redis の鍵は要らない）。
 *
 *   npm run accounts:bootstrap -- --login <ログインID> [--name <右上に出す名前>] [--days 30]
 *
 * 出すもの:
 *   1. コード（本人だけが控える。画面に1回だけ出す）
 *   2. FOLIO_BOOTSTRAP に入れる値（コードの scrypt ハッシュだけ。コードそのものは入らない）
 *
 * 使い方: 2 を Vercel の Production に Sensitive で入れて redeploy → 本番の /login で「ログインID」と
 * 「コード」で入る → すぐ自分のパスワードを決める → FOLIO_BOOTSTRAP を消す。
 * ★1回だけ使える。管理者のパスワードを忘れたときも、作り直して入れ直せば入れる。
 */
import { formatBootstrap } from "../../lib/account/bootstrap";
import { canonicalTemp, generateTempPassword, hashPassword } from "../../lib/account/password";
import { displayNameProblem, loginIdProblem, normalizeLoginId } from "../../lib/account/policy";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const loginId = normalizeLoginId(arg("login") ?? "");
const problem = loginIdProblem(loginId);
if (problem) {
  console.error(`--login <ログインID> を付けてください（${problem}）`);
  process.exit(1);
}
const name = (arg("name") ?? "").trim() || null;
const nameProblem = name ? displayNameProblem(name) : null;
if (nameProblem) {
  console.error(`--name: ${nameProblem}`);
  process.exit(1);
}
const days = Number(arg("days") ?? 30);
if (!Number.isFinite(days) || days <= 0 || days > 90) {
  console.error("--days は 1〜90 にしてください");
  process.exit(1);
}

const code = generateTempPassword();
const expSec = Math.floor(Date.now() / 1000) + Math.round(days * 24 * 60 * 60);
const value = formatBootstrap({ expSec, loginId, hash: await hashPassword(canonicalTemp(code)), name });

console.log("");
console.log(`ログインID: ${loginId}${name ? `（右上の名前: ${name}）` : ""}`);
console.log(`コード:     ${code}   ← 本人だけが控える（大文字・小文字とハイフンは区別しません）`);
console.log(`期限:       ${new Date(expSec * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}（日本時間）`);
console.log("");
console.log("FOLIO_BOOTSTRAP に入れる値（コードそのものは入っていません）:");
console.log(value);
console.log("");
console.log("入れ方の例: pbpaste | vercel env add FOLIO_BOOTSTRAP production --sensitive   （上の値をコピーしてから）");
