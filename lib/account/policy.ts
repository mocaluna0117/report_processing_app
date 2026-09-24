/**
 * アカウントの決まり（ログインID・表示名・パスワード）。純関数。画面とサーバーで同じものを使う。
 *
 * ★パスワードは8文字以上（利用者の決定 2026-09-24）。記号・大文字の決まりは作らない（長さの方が効く）。
 *   その代わり、ログインの失敗は回数を数えて止める（lib/account/rate-limit.ts）。
 */

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const LOGIN_ID_MAX = 32;
export const DISPLAY_NAME_MAX = 20;

/** よく使われる（すぐ当てられる）パスワード。小文字にして比べる */
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "passw0rd",
  "12345678",
  "123456789",
  "1234567890",
  "87654321",
  "11111111",
  "00000000",
  "qwertyui",
  "qwerty123",
  "asdfghjk",
  "abcd1234",
  "abcdefgh",
  "iloveyou",
  "sunshine",
  "letmein1",
  "welcome1",
  "admin123",
  "administrator",
  "folio123",
  "foliofolio",
  "rakuraku",
  "rakuraku1",
]);

/** ログインID を揃える（全角→半角・前後の空白・大文字→小文字） */
export function normalizeLoginId(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase();
}

/** ログインID の問題（無ければ null）。★揃えたあとの値で見る */
export function loginIdProblem(id: string): string | null {
  if (id.length < 3) return "ログインIDは3文字以上にしてください";
  if (id.length > LOGIN_ID_MAX) return `ログインIDは${LOGIN_ID_MAX}文字までです`;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    return "ログインIDは半角の英小文字・数字と「. _ -」だけにしてください（先頭は英数字）";
  }
  return null;
}

export function displayNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "表示名を入れてください";
  if ([...trimmed].length > DISPLAY_NAME_MAX) return `表示名は${DISPLAY_NAME_MAX}文字までです`;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "表示名に使えない文字があります";
  return null;
}

/** パスワードを揃える（全角の英数字を半角に。★前後の空白は取らない。打った本人の意図と違わないように） */
export function normalizePassword(raw: string): string {
  return raw.normalize("NFKC");
}

/**
 * 新しいパスワードの問題（無ければ空）。画面にそのまま出す。
 * current は今のパスワード（または仮のパスワード）。同じものは使わせない。
 */
export function passwordProblems(input: {
  password: string;
  confirm: string;
  loginId: string;
  current?: string | null;
}): string[] {
  const password = normalizePassword(input.password);
  const length = [...password].length;
  const problems: string[] = [];
  if (length < PASSWORD_MIN) problems.push(`パスワードは${PASSWORD_MIN}文字以上にしてください（いま${length}文字）`);
  if (length > PASSWORD_MAX) problems.push(`パスワードは${PASSWORD_MAX}文字までです`);
  if (length >= PASSWORD_MIN) {
    const lower = password.toLowerCase();
    if (/^(.)\1*$/u.test(password)) problems.push("同じ文字だけのパスワードは使えません");
    else if (COMMON_PASSWORDS.has(lower)) problems.push("よく使われるパスワードなので使えません。別のものにしてください");
    if (input.loginId && lower.includes(input.loginId.toLowerCase())) {
      problems.push("ログインIDを含むパスワードは使えません");
    }
  }
  if (input.current != null && input.current !== "" && normalizePassword(input.current) === password) {
    problems.push("今のパスワードと違うものにしてください");
  }
  if (normalizePassword(input.confirm) !== password) problems.push("確認のために入れたパスワードが一致しません");
  return problems;
}
