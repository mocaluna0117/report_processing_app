import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTACT_CATEGORIES,
  CONTACT_LIMITS,
  CONTACT_PAGES,
  type ContactPayload,
  browserLabel,
  buildContactText,
  collectDiagnostics,
  contactBlockers,
  contactCopyText,
  contactSubject,
  diagnosticsLines,
  oneLine,
  personalInfoWarning,
  redactContactText,
  sanitizeContactPayload,
} from "@/lib/contact/form";
import { fitWithin, imageKind } from "@/lib/contact/images";
import { createRateLimiter } from "@/lib/contact/rate-limit";
import { findPersonalInfo, redactPii } from "@/lib/summarize/redact";

// 問い合わせ（不具合・要望を開発者の Gmail へ送る）の規則（2026-09-24）。
// ★守ること: 送り先のアドレスをコードに書かない／一緒に送る情報は状態だけ（ID・フォルダー名を入れない）／
//   件名に改行を入れさせない／長すぎる本文は黙って切らずに断る。

const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const EDGE_WIN = `${CHROME_WIN} Edg/140.0.0.0`;
const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";

const payload = (over: Partial<ContactPayload> = {}): ContactPayload => ({
  category: "bug",
  page: "/tenmatsu",
  message: "一覧を再読み込みすると、完了の印が消えます。",
  name: "",
  diagnostics: { browser: "Chrome 140・Windows", viewport: "1920×1080", rakuraku: "ログイン中", shared: "connected" },
  ...over,
});

describe("ブラウザの名前", () => {
  it("Chrome・Edge・Safari と OS を短く出す", () => {
    expect(browserLabel(CHROME_WIN)).toBe("Chrome 140・Windows");
    expect(browserLabel(EDGE_WIN)).toBe("Edge 140・Windows");
    expect(browserLabel(SAFARI_MAC)).toBe("Safari 18・macOS");
  });

  it("読めなければ「不明」", () => {
    expect(browserLabel("")).toBe("不明なブラウザ・不明なOS");
  });
});

describe("一緒に送る情報", () => {
  it("状態だけを集める", () => {
    expect(
      collectDiagnostics({ ua: CHROME_WIN, width: 1920, height: 1080, loggedIn: false, sharedState: "prompt" }),
    ).toEqual({ browser: "Chrome 140・Windows", viewport: "1920×1080", rakuraku: "未ログイン", shared: "prompt" });
  });

  it("分からないものは「不明」にする", () => {
    const d = collectDiagnostics({ ua: CHROME_WIN, width: null, height: 0, loggedIn: null, sharedState: null });
    expect(d.viewport).toBe("不明");
    expect(d.rakuraku).toBe("不明");
    expect(d.shared).toBe("unknown");
  });

  it("★入れられる項目は4つだけ（ログインID・フォルダーの名前の入る場所が無い）", () => {
    const d = collectDiagnostics({ ua: CHROME_WIN, width: 1, height: 1, loggedIn: true, sharedState: "connected" });
    expect(Object.keys(d).sort()).toEqual(["browser", "rakuraku", "shared", "viewport"]);
  });

  it("画面とメールに出す行", () => {
    expect(diagnosticsLines(payload().diagnostics)).toEqual([
      "ブラウザ: Chrome 140・Windows",
      "画面の大きさ: 1920×1080",
      "楽楽精算: ログイン中",
      "共有フォルダー: 接続済み",
    ]);
  });
});

describe("お客様の情報らしき文字", () => {
  it("電話番号・メール・郵便番号・住所・敬称付きの名前を見つける", () => {
    expect(findPersonalInfo("山田様から 090-0000-1234 に電話")).toEqual(["電話番号", "お名前"]);
    expect(findPersonalInfo("taro@example.com へ")).toEqual(["メールアドレス"]);
    expect(findPersonalInfo("〒123-4567 東京都架空区北町1-2-3")).toEqual(["郵便番号", "住所"]);
    expect(findPersonalInfo("09000001234")).toEqual(["電話番号"]);
  });

  it("★電話番号の一部（000-1234）を郵便番号と取り違えない", () => {
    expect(findPersonalInfo("090-0000-1234")).toEqual(["電話番号"]);
  });

  it("画面の文言や一般語では出さない", () => {
    expect(findPersonalInfo("「一覧を再読み込み」を押すと、同様の事象が出ます。お客様カードの仕様です。")).toEqual([]);
    expect(findPersonalInfo("2026/09/24 に取得。10件中3件が保留。")).toEqual([]);
  });

  it("★要約の伏せ字は変わらない（パターンを共有しただけ）", () => {
    expect(redactPii("高橋様より東京都杉並区高円寺北1-2-3の件で090-0000-1234へ連絡。")).toBe(
      "お客様より（住所）の件で（電話番号）へ連絡。",
    );
  });

  it("注意の文は見つけた種類を並べ、そのままでよい場合も書く", () => {
    const text = personalInfoWarning(["電話番号", "住所"]);
    expect(text).toContain("電話番号・住所らしき文字があります");
    expect(text).toContain("そのままで構いません");
    expect(personalInfoWarning([])).toBeNull();
  });

  it("「伏せ字にする」は郵便番号も伏せる", () => {
    expect(redactContactText("〒123-4567 の山田様、090-0000-1234")).toBe("（郵便番号） のお客様、（電話番号）");
    expect(findPersonalInfo(redactContactText("〒123-4567 東京都架空区北町1-2-3 山田様 090-0000-1234"))).toEqual([]);
  });
});

describe("「送信」を押せない理由", () => {
  const draft = {
    message: "内容",
    name: "",
    photos: 0,
    photoBytes: 0,
    photosChecked: false,
    sending: false,
  };

  it("書けていれば押せる", () => {
    expect(contactBlockers(draft)).toEqual([]);
  });

  it("本文が空・長すぎるときは押せない", () => {
    expect(contactBlockers({ ...draft, message: "  " })).toEqual(["内容を書いてください"]);
    expect(contactBlockers({ ...draft, message: "あ".repeat(CONTACT_LIMITS.messageChars + 1) })[0]).toContain(
      "4,000字まで",
    );
  });

  it("★写真があるときは、お客様の情報が写っていないことの印を押すまで送れない", () => {
    expect(contactBlockers({ ...draft, photos: 1, photoBytes: 100 })).toEqual([
      "写真にお客様の情報が写っていないか確かめて、印を押してください",
    ]);
    expect(contactBlockers({ ...draft, photos: 1, photoBytes: 100, photosChecked: true })).toEqual([]);
  });

  it("写真の枚数・大きさの上限", () => {
    const over = { ...draft, photos: CONTACT_LIMITS.photos + 1, photoBytes: CONTACT_LIMITS.totalBytes + 1, photosChecked: true };
    expect(contactBlockers(over)).toEqual(["写真は 3枚までです", "写真が大きすぎます。枚数を減らしてください"]);
  });

  it("送っている途中は押せない", () => {
    expect(contactBlockers({ ...draft, sending: true })).toEqual(["送っています"]);
  });
});

describe("受け取った中身の検査（サーバーで通す）", () => {
  it("決まった値だけを受け付ける", () => {
    const result = sanitizeContactPayload(payload());
    expect(result).toEqual({ ok: true, payload: payload() });
  });

  it("種類・画面が決まったもの以外なら断る", () => {
    expect(sanitizeContactPayload(payload({ category: "spam" as never }))).toMatchObject({ ok: false });
    expect(sanitizeContactPayload(payload({ page: "/admin" }))).toMatchObject({ ok: false });
    expect(sanitizeContactPayload(null)).toMatchObject({ ok: false });
  });

  it("★長すぎる本文は切らずに断る", () => {
    const result = sanitizeContactPayload(payload({ message: "あ".repeat(CONTACT_LIMITS.messageChars + 1) }));
    expect(result).toMatchObject({ ok: false });
  });

  it("制御文字を取り除き、名前は1行にする", () => {
    const result = sanitizeContactPayload(payload({ message: "一行目\n二行目\u0007", name: "山田\r\nBcc: x" }));
    expect(result.ok && result.payload.message).toBe("一行目\n二行目");
    expect(result.ok && result.payload.name).toBe("山田 Bcc: x");
  });

  it("★一緒に送る情報も、決まった形以外は捨てる（余計な項目は入らない）", () => {
    const raw = {
      ...payload(),
      diagnostics: { browser: "Chrome", viewport: "<script>", rakuraku: "ID: 12345", shared: "x", userId: "12345" },
    };
    const result = sanitizeContactPayload(raw);
    expect(result.ok && result.payload.diagnostics).toEqual({
      browser: "Chrome",
      viewport: "不明",
      rakuraku: "不明",
      shared: "unknown",
    });
  });

  it("画面の選択肢は、ヘッダーの画面と「分からない」", () => {
    expect(CONTACT_PAGES.map((p) => p.path)).toEqual(["/", "/after", "/tenmatsu", "/senketsu", "/natsuin", ""]);
    expect(CONTACT_CATEGORIES.map((c) => c.label)).toEqual(["不具合", "改善の要望", "質問", "その他"]);
  });
});

describe("メールの件名と本文", () => {
  it("件名に種類・画面・本文の頭を入れる", () => {
    expect(contactSubject(payload())).toBe("[Folio] 不具合: 顛末書 — 一覧を再読み込みすると、完了の印が消えます。");
  });

  it("★件名に改行を入れさせない（見出しを崩させない）", () => {
    const subject = contactSubject(payload({ message: "件名\r\nBcc: someone\n本文" }));
    expect(subject).not.toMatch(/[\r\n]/);
    expect(oneLine("a\u2028b")).toBe("a b");
  });

  it("本文に、種類・画面・本文・一緒に送った情報・版・日時を入れる", () => {
    const text = buildContactText(payload({ name: "架空　花子" }), {
      version: "abc1234def",
      environment: "production",
      at: 1_700_000_000_000,
      photos: 2,
    });
    expect(text).toContain("種類: 不具合");
    expect(text).toContain("画面: 顛末書 (/tenmatsu)");
    expect(text).toContain("お名前: 架空　花子");
    expect(text).toContain("一覧を再読み込みすると");
    expect(text).toContain("Folio の版: abc1234 (production)");
    expect(text).toContain("共有フォルダー: 接続済み");
    expect(text).toContain("送信: 2023/11/15 07:13（日本時間）");
    expect(text).toContain("写真: 2枚");
  });

  it("名前が無ければ「未記入」、画面が無ければ「分からない」", () => {
    const text = buildContactText(payload({ page: "" }), { version: null, environment: null, at: 0, photos: 0 });
    expect(text).toContain("お名前: （未記入）");
    expect(text).toContain("画面: どの画面でもない・分からない\n");
    expect(text).toContain("Folio の版: 不明");
  });

  it("送れなかったときにコピーする文は、件名と本文", () => {
    const text = contactCopyText(payload(), 0);
    expect(text.startsWith("[Folio] 不具合: 顛末書")).toBe(true);
    expect(text).toContain("一緒に送った情報");
  });
});

describe("写真", () => {
  it("先頭のバイトで種類を見分ける", () => {
    expect(imageKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(imageKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageKind(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
  });

  it("★写真でないもの（拡張子だけ変えたもの）は受け付けない", () => {
    expect(imageKind(new TextEncoder().encode("<svg xmlns=...>"))).toBeNull();
    expect(imageKind(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
    expect(imageKind(new Uint8Array())).toBeNull();
  });

  it("長い辺を上限まで縮める（大きくはしない）", () => {
    expect(fitWithin(3200, 1800, 1600)).toEqual({ width: 1600, height: 900 });
    expect(fitWithin(900, 2000, 1600)).toEqual({ width: 720, height: 1600 });
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });
});

describe("送る回数の上限", () => {
  it("決まった時間の中で max 回まで。過ぎたらまた送れる", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    expect(limiter.take(0)).toBe(true);
    expect(limiter.take(1_000)).toBe(true);
    expect(limiter.take(2_000)).toBe(false);
    expect(limiter.waitSeconds(2_000)).toBe(58);
    // 最初の1通（0秒）が1分の外に出たので、また1通送れる。次は 1,000ミリ秒の分が外に出るまで待つ
    expect(limiter.take(60_000)).toBe(true);
    expect(limiter.waitSeconds(60_000)).toBe(1);
  });
});

describe("★送り先のアドレスをコードに書かない（公開リポジトリ）", () => {
  const ROOT = resolve(__dirname, "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  const files = [
    ...["app", "lib", "components"].flatMap((dir) => walk(join(ROOT, dir))),
    join(ROOT, "README.md"),
    join(ROOT, ".env.example"),
  ].filter((path) => /\.(tsx?|md|mjs|example)$/.test(path));

  it("Gmail のアドレスがどこにも無い", () => {
    const hits = files.filter((path) => /@gmail\.com/i.test(readFileSync(path, "utf8")));
    expect(hits).toEqual([]);
  });
});
