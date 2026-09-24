import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FOLIO_LOGOUT_LABEL,
  FOLIO_LOGOUT_TITLE,
  LOGIN_DISMISSED_KEY,
  LOGIN_RULE_TEXT,
  clearLoginDismissal,
  closeLoginDialog,
  getLoginDialogState,
  isLoginDismissedInTab,
  loginDialogCopy,
  markLoginDismissedInTab,
  openLoginDialog,
  rakurakuChip,
  resetLoginDialogForTests,
  shouldAutoCloseLogin,
  shouldAutoOpenLogin,
  shouldPromptOnSessionLost,
  subscribeLoginDialog,
} from "@/lib/rakuraku-login-dialog";
import { forgetLogin, resetFolderSessions, setLogin } from "@/lib/tenmatsu/local/session";

// 楽楽精算のログインを Folio 全体で1か所にする（2026-09-22）。
// ★いちばん大事なのは「勝手にログインしない」こと。ここは開く・閉じるだけを決め、
//   ログインは利用者がボタンを押したときにしか走らない（アカウントのロックを避けるため）。

/** sessionStorage の作り物（node には window が無いので、テストの間だけ置く） */
class FakeStorage {
  map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

const globals = globalThis as unknown as { window?: { sessionStorage: FakeStorage } };
let storage: FakeStorage;

/** 再読み込み相当（メモリだけ消え、タブの控えは残る） */
const reload = () => {
  resetFolderSessions();
  resetLoginDialogForTests();
};

beforeEach(() => {
  storage = new FakeStorage();
  globals.window = { sessionStorage: storage };
  reload();
});

afterEach(() => {
  delete globals.window;
  reload();
});

const login = () => setLogin({ sessionToken: "sealed-1", expiresAt: Date.now() + 60_000 });

describe("画面を開いたときに自分から出すか", () => {
  const base = { kind: "tenmatsu" as const, loggedIn: false, dismissedInTab: false, alreadyOpen: false };

  it("顛末書系で未ログインなら出す", () => {
    expect(shouldAutoOpenLogin(base)).toBe(true);
  });

  it("★定期点検・アフター（種類が無い画面）では絶対に出さない", () => {
    // この2画面は楽楽精算を使わないので、顧客データだけ使う日にログインを求めない
    expect(shouldAutoOpenLogin({ ...base, kind: null })).toBe(false);
    expect(shouldAutoOpenLogin({ ...base, kind: null, dismissedInTab: false, loggedIn: false })).toBe(false);
  });

  it("ログインしていれば出さない", () => {
    expect(shouldAutoOpenLogin({ ...base, loggedIn: true })).toBe(false);
  });

  it("★一度閉じたタブでは出さない（一覧を見るだけの人を邪魔しない）", () => {
    expect(shouldAutoOpenLogin({ ...base, dismissedInTab: true })).toBe(false);
  });

  it("もう開いているなら出し直さない", () => {
    expect(shouldAutoOpenLogin({ ...base, alreadyOpen: true })).toBe(false);
  });
});

describe("このタブでは出さない、の印", () => {
  it("ログインしないまま閉じたら印を押す。再読み込みしても残る", () => {
    openLoginDialog("auto", "tenmatsu");
    closeLoginDialog();
    expect(isLoginDismissedInTab()).toBe(true);
    reload();
    expect(isLoginDismissedInTab()).toBe(true);
  });

  it("★ログインしてから閉じたときは押さない（次に切れたら出したい）", () => {
    openLoginDialog("auto", "tenmatsu");
    login();
    closeLoginDialog();
    expect(isLoginDismissedInTab()).toBe(false);
  });

  it("ログインできたら消す", () => {
    markLoginDismissedInTab();
    clearLoginDismissal();
    expect(isLoginDismissedInTab()).toBe(false);
  });

  it("自分でログアウトしたときも押せる（押した直後にまた出てこない）", () => {
    login();
    markLoginDismissedInTab();
    forgetLogin();
    expect(isLoginDismissedInTab()).toBe(true);
  });

  it("印があっても、自分で開くことはできる", () => {
    markLoginDismissedInTab();
    openLoginDialog("manual", "tenmatsu");
    expect(getLoginDialogState().open).toBe(true);
  });

  it("sessionStorage が使えなくても落ちない（出さない扱いにしない）", () => {
    delete globals.window;
    expect(() => markLoginDismissedInTab()).not.toThrow();
    expect(isLoginDismissedInTab()).toBe(false);
    expect(() => clearLoginDismissal()).not.toThrow();
    expect(() => closeLoginDialog()).not.toThrow();
  });

  it("★scripts/help-shots/seed.ts が直に書いている文字列と食い違わない", () => {
    // 写真を撮るときはブラウザの中で仕込むので import できない。ここで突き合わせる
    expect(readFileSync("scripts/help-shots/seed.ts", "utf8")).toContain(LOGIN_DISMISSED_KEY);
  });
});

describe("開く・閉じる", () => {
  it("開いた理由と画面の種類を持つ", () => {
    openLoginDialog("session-lost", "senketsu");
    expect(getLoginDialogState()).toEqual({ open: true, reason: "session-lost", kind: "senketsu" });
  });

  it("変わったら知らせる", () => {
    const seen: boolean[] = [];
    const stop = subscribeLoginDialog((s) => seen.push(s.open));
    openLoginDialog("manual");
    closeLoginDialog();
    stop();
    openLoginDialog("manual");
    expect(seen).toEqual([true, false]);
  });
});

describe("作業の途中でログインが切れたとき", () => {
  it("部門を読むときに切れたら出す", () => {
    expect(shouldPromptOnSessionLost({ during: "departments", hasPassword: true })).toBe(true);
  });

  it("★取得の最中は、パスワードがあれば出さない（この実行の中で1回だけ入り直すのを邪魔しない）", () => {
    expect(shouldPromptOnSessionLost({ during: "run", hasPassword: true })).toBe(false);
  });

  it("取得の最中でも、パスワードが無ければ出す（入り直せないため）", () => {
    expect(shouldPromptOnSessionLost({ during: "run", hasPassword: false })).toBe(true);
  });

  it("取得が終わった時点で切れていれば出す", () => {
    expect(shouldPromptOnSessionLost({ during: "run-end", hasPassword: true })).toBe(true);
  });
});

describe("ほかの場所でログインできたとき", () => {
  it("自分から出したものは閉じる", () => {
    expect(shouldAutoCloseLogin({ open: true, reason: "auto", loggedIn: true })).toBe(true);
    expect(shouldAutoCloseLogin({ open: true, reason: "session-lost", loggedIn: true })).toBe(true);
  });

  it("★自分で開いたものは閉じない（ログアウトしに来たのかもしれない）", () => {
    expect(shouldAutoCloseLogin({ open: true, reason: "manual", loggedIn: true })).toBe(false);
  });

  it("まだログインしていなければ閉じない", () => {
    expect(shouldAutoCloseLogin({ open: true, reason: "auto", loggedIn: false })).toBe(false);
  });
});

describe("ヘッダーの表示", () => {
  const chip = (over: Parameters<typeof rakurakuChip>[0]) => rakurakuChip(over);

  it("★分かる前は「楽楽精算」だけ（サーバーで描いた中身と食い違わせない）", () => {
    const view = chip({ known: false, loggedIn: false, userId: "17xxxx", onDocPage: true });
    expect(view.text).toBe("楽楽精算");
    expect(view.tone).toBe("unknown");
    expect(view.dot).toBe(false);
    expect(view.title).not.toContain("17xxxx");
  });

  it("★楽楽精算を使う画面で未ログインなら、いちばん目立たせる", () => {
    const view = chip({ known: true, loggedIn: false, userId: null, onDocPage: true });
    expect(view.text).toBe("楽楽精算: 未ログイン");
    expect(view.tone).toBe("alert");
    expect(view.dot).toBe(true);
    expect(view.title).toContain("この画面の取得には");
  });

  it("★使わない画面（定期点検・アフター）では静かにする", () => {
    const view = chip({ known: true, loggedIn: false, userId: null, onDocPage: false });
    expect(view.text).toBe("楽楽精算: 未ログイン");
    expect(view.tone).toBe("off");
    expect(view.dot).toBe(false);
  });

  it("ログイン中は ID を添える（画面の文字には出さない）", () => {
    const view = chip({ known: true, loggedIn: true, userId: "ID-1", onDocPage: true });
    expect(view.text).toBe("楽楽精算: ログイン中");
    expect(view.tone).toBe("on");
    expect(view.dot).toBe(true);
    expect(view.title).toContain("ID-1");
    expect(view.text).not.toContain("ID-1");
  });

  it("ログイン中の見た目は、どの画面でも同じ", () => {
    const a = chip({ known: true, loggedIn: true, userId: null, onDocPage: true });
    const b = chip({ known: true, loggedIn: true, userId: null, onDocPage: false });
    expect(a).toEqual(b);
  });
});

describe("Folio 自体のログアウト", () => {
  it("★どちらのログアウトか、名前で分かるようにする", () => {
    expect(FOLIO_LOGOUT_LABEL).toContain("Folio");
    expect(FOLIO_LOGOUT_LABEL).toContain("ログアウト");
  });

  it("楽楽精算のログアウトの場所も添える", () => {
    expect(FOLIO_LOGOUT_TITLE).toContain("楽楽精算");
    expect(FOLIO_LOGOUT_TITLE).toContain("共有の端末");
  });

  it("★楽楽精算側の文言とは別物（取り違えない）", () => {
    expect(FOLIO_LOGOUT_LABEL).not.toContain("パスワードを忘れる");
  });

  it("★このタブの楽楽精算のログインも一緒に忘れることを書く", () => {
    expect(FOLIO_LOGOUT_TITLE).toContain("このタブの楽楽精算のログインも一緒に忘れます");
  });
});

describe("★Folio からログアウトしたら・ログイン画面に来たら、このタブの楽楽精算のログインを消す（中身を読んで見張る）", () => {
  const nav = readFileSync("components/mode-nav.tsx", "utf8");

  it("ログアウトのフォームを送る前に消す", () => {
    const form = nav.slice(nav.indexOf('action="/api/logout"'));
    expect(form.slice(0, form.indexOf("</form>"))).toContain("clearTabForAnotherPerson()");
  });

  it("★ログイン画面に移ってきたとき（読み込み直さない移動も）も消す。pathname を見る", () => {
    expect(nav).toMatch(/if \(pathname === "\/login"\) clearTabForAnotherPerson\(\);\s*\}, \[pathname\]\);/);
  });

  it("消すのは、楽楽精算のログイン・閉じた印・問い合わせの下書き（ログインIDの覚えは消さない）", () => {
    const signOut = readFileSync("lib/account/sign-out.ts", "utf8");
    expect(signOut).toContain("forgetLogin();");
    expect(signOut).toContain("clearLoginDismissal();");
    expect(signOut).toContain("clearContactDraft();");
    expect(signOut).not.toMatch(/clearUserId|saveUserId\(/);
  });
});

describe("★ログインを勝手に呼ばない（画面のテスト基盤が無いので、中身を読んで見張る）", () => {
  const source = readFileSync("components/rakuraku-login-dialog.tsx", "utf8");

  it("ログインを呼ぶのは1か所だけ", () => {
    expect(source.split("api.login(").length - 1).toBe(1);
  });

  it("そこは利用者が押したとき（フォームの送信）で、effect の中ではない", () => {
    // submit 関数の中にだけあること。useEffect の塊に login の呼び出しが無いこと
    for (const block of source.split("useEffect(").slice(1)) {
      const body = block.slice(0, block.indexOf("}, ["));
      expect(body).not.toContain("api.login");
      expect(body).not.toContain("submit(");
    }
    expect(source).toContain("onSubmit=");
  });

  it("やり直しの仕掛け（タイマー）を持たない", () => {
    expect(source).not.toContain("setTimeout");
    expect(source).not.toContain("setInterval");
  });

  it("ヘッダーはモーダルを1つだけ置く", () => {
    const nav = readFileSync("components/mode-nav.tsx", "utf8");
    expect(nav.split("<RakurakuLoginDialog />").length - 1).toBe(1);
    expect(nav).not.toContain("api.login");
  });
});

describe("モーダルの文言", () => {
  it("★押す前の説明から「ロック」と「やり直しません」を落とさない", () => {
    expect(LOGIN_RULE_TEXT).toContain("ロック");
    expect(LOGIN_RULE_TEXT).toContain("やり直しません");
    expect(LOGIN_RULE_TEXT).toContain("パスワードは保存しません");
  });

  it("切れたときは、自動でやり直さないことを見出しの次に書く", () => {
    const copy = loginDialogCopy("session-lost", "顛末書");
    expect(copy.title).toContain("切れました");
    expect(copy.lead).toContain("自動ではログインし直しません");
  });

  it("自分から出したときは、閉じても開き直せると書く", () => {
    const copy = loginDialogCopy("auto", "顛末書");
    expect(copy.lead).toContain("顛末書");
    expect(copy.lead).toContain("閉じても");
  });

  it("自分で開いたときは、3画面で共通だと書く", () => {
    expect(loginDialogCopy("manual", null).lead).toContain("共通");
  });
});
