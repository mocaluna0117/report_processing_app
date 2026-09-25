import { beforeEach, describe, expect, it } from "vitest";
import type { StatusPayload } from "@/lib/tenmatsu/client";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import { type RunAuth, type RunDeps, startRun } from "@/lib/tenmatsu/local/job";
import { LOCAL_KINDS } from "@/lib/tenmatsu/local/kind-config";
import type { Manifest } from "@/lib/tenmatsu/local/manifest";
import { readRecords, registerPending, appendProcessed } from "@/lib/tenmatsu/local/records";
import { type FetchResult, type RakurakuApi, RakurakuApiError } from "@/lib/tenmatsu/local/server-api";
import { FakeFs } from "./helpers/fake-fs";
import { type FakeApiScript, createFakeApi, file, scanOf, target } from "./helpers/fake-rakuraku-api";
import { makePdf, makePng, pageSizes } from "./helpers/pdf-parts";

// 期待値は移植元 tenmatsu.py の run_job / process_one の検証（server_test.py「取得」「保留」「見送り」）から写した。すべて架空の値

const NOW = new Date(2026, 8, 13, 11, 0, 0);
const tenmatsu = LOCAL_KINDS.tenmatsu;

let body: Uint8Array;
let attachmentPdf: Uint8Array;
beforeEach(async () => {
  body = await makePdf(2, [595, 842]);
  attachmentPdf = await makePdf(1, [400, 400]);
});

function fetched(extra: Partial<FetchResult> = {}): FetchResult {
  return {
    fields: { shinsei_date: "2026/09/10 11:37:00", where: "注文受注物件：架空台1丁目A号棟\u3000施主名：架空\u3000太郎", pj: "9901230101", final_approved_at: "2026/09/10 17:36" },
    body: file("body", 0, "本体", ".pdf", body),
    attachmentNames: [],
    attachments: [],
    failures: [],
    linked: null,
    compose: null,
    ...extra,
  };
}

interface Setup {
  fs: FakeFs;
  store: FolderStore;
  auth: RunAuth & { tokenValue: string | null; registered: boolean; api: RakurakuApi | null };
  sleeps: number[];
}

function setup(options: { token?: string | null; registered?: boolean } = {}): Setup {
  const fs = new FakeFs();
  const auth = {
    tokenValue: options.token === undefined ? "token-0" : options.token,
    /** このPCに楽楽精算の登録（暗号の控え）があるか */
    registered: options.registered ?? true,
    api: null as RakurakuApi | null,
    token() {
      return this.tokenValue;
    },
    setToken(token: string | null) {
      this.tokenValue = token;
    },
    // 本物は ensureSession(() => loginWithStoredCredential(api))。登録が無ければ送らずに止まる
    async login() {
      if (!this.registered) {
        throw new RakurakuApiError("CREDENTIAL_MISSING", "楽楽精算のIDとパスワードが登録されていません。アカウントの画面で登録してください");
      }
      return (await (this.api as RakurakuApi).login("sealed-credential")).sessionToken;
    },
  };
  return { fs, store: new FolderStore(fs.root), auth, sleeps: [] };
}

async function run(s: Setup, script: FakeApiScript, limit = 10, patch: Partial<RunDeps> = {}) {
  const api = createFakeApi(script);
  s.auth.api = api;
  const updates: StatusPayload[] = [];
  const handle = startRun(
    {
      store: s.store,
      cfg: tenmatsu,
      api,
      auth: s.auth,
      deptCode: "1800",
      now: () => NOW,
      sleep: async (ms) => {
        s.sleeps.push(ms);
      },
      ...patch,
    },
    { limit },
  );
  handle.subscribe((status) => updates.push(status));
  const status = await handle.finished;
  const log = handle.snapshot(0).log!.map((l) => l.text);
  return { api, status, log, updates, handle };
}

describe("取得して保存する", () => {
  it("★対象を1件ずつ取得し、保存した直後に記録する（一覧の値に伝票画面の値を重ねる）", async () => {
    const s = setup();
    const { status, log, api } = await run(s, {
      scan: scanOf([
        target("TE00009101", { shinsei_date: "2026/09/10", shinseisha: "テスト 太郎", amount: "16,500 円", payee: "テスト工業", where: "注文受注物件：架空台…" }),
        target("TE00009102", { shinsei_date: "2026/09/09" }),
      ]),
      fetch: { TE00009101: fetched({ attachmentNames: ["見積.pdf"], attachments: [file("attachment", 1, "見積.pdf", ".pdf", attachmentPdf)] }), TE00009102: fetched() },
    });
    expect(status.state).toBe("done");
    expect(status.processed).toBe(2);
    expect(status.saved).toEqual([
      { denpyo_no: "TE00009101", file: "顛末書№9101.pdf" },
      { denpyo_no: "TE00009102", file: "顛末書№9102.pdf" },
    ]);
    expect(await pageSizes(s.fs.get("顛末書№9101.pdf")!)).toEqual([
      [595, 842],
      [595, 842],
      [400, 400],
    ]);
    const records = await readRecords(s.store, tenmatsu);
    expect(records.done).toEqual(["TE00009101", "TE00009102"]);
    expect(records.log[0]).toEqual({
      denpyo_no: "TE00009101",
      file: "顛末書№9101.pdf",
      at: "2026-09-13T11:00:00",
      // ★申請日は伝票画面の秒まである値、どこでは伝票画面の全文で上書きし、一覧にしか無い値は残す
      shinsei_date: "2026/09/10 11:37:00",
      shinseisha: "テスト 太郎",
      amount: "16,500 円",
      payee: "テスト工業",
      where: "注文受注物件：架空台1丁目A号棟\u3000施主名：架空\u3000太郎",
      pj: "9901230101",
      final_approved_at: "2026/09/10 17:36",
      // ★保存したPDFの中身の指紋 (名前を変えられても中身で探せるように)
      pdf_size: s.fs.get("顛末書№9101.pdf")!.byteLength,
      pdf_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(log).toContain("  OK 保存: 顛末書№9101.pdf");
    expect(log).toContain("完了: 2件を保存しました");
    // 伝票のあいだは間隔をあける（最後の後は待たない）
    expect(s.sleeps).toEqual([1500]);
    // すでにログインしているので、ログインし直さない
    expect(api.calls.filter((c) => c.method === "login")).toHaveLength(0);
    // 部門を渡している
    expect(api.calls.find((c) => c.method === "scan")?.request).toMatchObject({ kind: "tenmatsu", deptCode: "1800", limit: 10 });
  });

  it("★保存済み・保留中の伝票は、一覧を読むときに対象から外すよう伝える", async () => {
    const s = setup();
    await appendProcessed(s.store, tenmatsu, "TE1", "a.pdf", null, NOW);
    await registerPending(s.store, tenmatsu, "TE2", "TE2", [], null, NOW);
    const { api } = await run(s, { scan: scanOf([]) });
    expect((api.calls[0].request as { done: string[] }).done).toEqual(["TE1", "TE2"]);
  });

  it("★対象が上限より多ければ先頭だけ取り、残りの件数を必ず伝える（黙って切り捨てない）", async () => {
    const s = setup();
    const { status, log, api } = await run(
      s,
      { scan: scanOf([target("TE1"), target("TE2"), target("TE3")]), fetch: { TE1: fetched() } },
      1,
    );
    expect(api.calls.filter((c) => c.method === "fetch")).toHaveLength(1);
    expect(status.remaining).toBe(2);
    expect(log.some((l) => l.includes("対象 3件のうち、今回は先頭 1件だけ"))).toBe(true);
  });

  it("★対象が無ければ理由の分かる1行で終える。読み切れていなければそう言う", async () => {
    const s = setup();
    const none = await run(s, { scan: scanOf([], { total: 701, last: 701 }) });
    expect(none.status.message).toBe("新規対象はありません（701件すべてを確認しました）。");
    const cut = await run(setup(), { scan: scanOf([], { stoppedEarly: true, total: 701, last: 200, reason: "3ページ目へ進めませんでした" }) });
    expect(cut.status.state).toBe("done");
    expect(cut.status.message).toContain("701件中 200件目まで");
  });

  it("保存先に同じ名前があれば上書きせず、フル伝票№の名前にする", async () => {
    const s = setup();
    s.fs.put("顛末書№9101.pdf", "前からある");
    await run(s, { scan: scanOf([target("TE00009101")]), fetch: { TE00009101: fetched() } });
    expect(s.fs.text("顛末書№9101.pdf")).toBe("前からある");
    expect(s.fs.get("顛末書№TE00009101.pdf")).not.toBeNull();
  });

  it("★動画は結合せずに飛ばし、飛ばした名前を記録に残す（保留にはしない）", async () => {
    const s = setup();
    const video = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
    await run(s, {
      scan: scanOf([target("TE1")]),
      fetch: { TE1: fetched({ attachmentNames: ["現場動画.mp4", "写真.jpg"], attachments: [file("attachment", 1, "現場動画.mp4", ".mp4", video), file("attachment", 2, "写真.jpg", ".png", makePng(40, 30))] }) },
    });
    const records = await readRecords(s.store, tenmatsu);
    expect(records.log[0].skipped_attachments).toEqual(["現場動画.mp4"]);
    expect(records.pending).toEqual({});
  });
});

describe("一覧の経路", () => {
  it("★どの経路で開いたかを記録の行と状態に出す（一覧に出る伝票の範囲が違うため）", async () => {
    const s = setup();
    const { status, log } = await run(s, {
      scan: scanOf([]),
      route: { kind: "tenmatsu", route: "shinsei", label: "ワークフロー（申請検索）", scope: "own", how: "fallback" },
    });
    expect(log.some((l) => l.includes("一覧の経路: ワークフロー（申請検索）（切り替え）"))).toBe(true);
    expect(status.route).toEqual({ label: "ワークフロー（申請検索）", scope: "own", how: "fallback" });
  });

  it("紐づく専決決裁書の経路は、自分の種類の表示に混ぜない", async () => {
    const s = setup();
    const { status, log } = await run(s, {
      scan: scanOf([]),
      route: { kind: "senketsu", route: "shinsei", label: "ワークフロー（申請検索）", scope: "own", how: "default" },
    });
    expect(log.some((l) => l.includes("紐づく専決決裁書"))).toBe(true);
    expect(status.route).toBeUndefined();
  });

  it("★経路を固定したら、その指定を毎回の呼び出しに乗せる", async () => {
    const s = setup();
    const { api } = await run(s, { scan: scanOf([]) }, 10, { routePin: "shinsei" });
    const scan = api.calls.find((c) => c.method === "scan")!;
    expect((scan.request as { route?: string }).route).toBe("shinsei");
  });

  it("固定していなければ経路を指定しない（自動で順に試す）", async () => {
    const s = setup();
    const { api } = await run(s, { scan: scanOf([]) });
    const scan = api.calls.find((c) => c.method === "scan")!;
    expect("route" in (scan.request as object)).toBe(false);
  });
});

describe("保留にする", () => {
  it("★取れなかった添付・結合できない添付があれば、部品と途中の PDF を _保留 へ置いてから記録する", async () => {
    const s = setup();
    const { status, log } = await run(s, {
      scan: scanOf([target("TE00009106", { amount: "3,300 円" })]),
      fetch: {
        TE00009106: fetched({
          attachmentNames: ["見積.xlsx", "写真.png", "壊れた.pdf"],
          attachments: [file("attachment", 1, "見積.xlsx", ".xlsx", new Uint8Array([0x50, 0x4b, 3, 4])), file("attachment", 2, "写真.png", ".png", makePng(40, 30))],
          failures: [{ index: 3, name: "壊れた.pdf", code: "ATTACHMENT_FAILED", reason: "60秒待ってもダウンロードが始まりませんでした", retryable: true }],
        }),
      },
    });
    expect(status.processed).toBe(0);
    expect(status.pending).toEqual([{ denpyo_no: "TE00009106", missing: ["見積.xlsx", "壊れた.pdf"], awaiting: false }]);
    expect(s.fs.files().filter((f) => f.startsWith("_保留"))).toEqual([
      "_保留/TE00009106/000_本体.pdf",
      "_保留/TE00009106/001_見積.xlsx",
      "_保留/TE00009106/002_写真.png",
      "_保留/TE00009106/_merged.pdf",
      "_保留/TE00009106/manifest.json",
    ]);
    const manifest = JSON.parse(s.fs.text("_保留/TE00009106/manifest.json")!) as Manifest;
    expect(manifest).toMatchObject({ denpyo_no: "TE00009106", kind: "tenmatsu", at: "2026-09-13T11:00:00", merged_pages: 3 });
    expect(manifest.parts.map((p) => [p.index, p.status, p.file ?? null, p.pages])).toEqual([
      [0, "ok", "000_本体.pdf", 2],
      [1, "failed", "001_見積.xlsx", 0],
      [2, "ok", "002_写真.png", 1],
      [3, "failed", null, 0],
    ]);
    const records = await readRecords(s.store, tenmatsu);
    expect(records.done).toEqual([]);
    expect(records.pending.TE00009106.missing.map((m) => m.name)).toEqual(["見積.xlsx", "壊れた.pdf"]);
    expect(records.pending.TE00009106.meta).toMatchObject({ amount: "3,300 円", pj: "9901230101" });
    expect(log.some((l) => l.includes("保留にしました"))).toBe(true);
    // 正式なフォルダーには入れない
    expect(s.fs.files().some((f) => f.startsWith("顛末書№"))).toBe(false);
  });
});

describe("時間切れの添付", () => {
  it("★時間の上限で取れなかった添付は、1つずつ取り直して結合する", async () => {
    const s = setup();
    const { api } = await run(s, {
      scan: scanOf([target("TE1")]),
      fetch: {
        TE1: fetched({
          attachmentNames: ["見積.pdf"],
          failures: [{ index: 1, name: "見積.pdf", code: "TIME_BUDGET_EXCEEDED", reason: "時間の上限", retryable: true }],
        }),
      },
      attachment: (request) => file("attachment", request.index, request.expectedName, ".pdf", attachmentPdf),
    });
    expect(api.calls.find((c) => c.method === "attachment")?.request).toMatchObject({ index: 1, expectedName: "見積.pdf", denpyoNo: "TE1" });
    expect(await pageSizes(s.fs.get("顛末書№TE1.pdf")!)).toEqual([
      [595, 842],
      [595, 842],
      [400, 400],
    ]);
  });

  it("取り直しにも失敗したら、その添付は保留にする", async () => {
    const s = setup();
    const { status } = await run(s, {
      scan: scanOf([target("TE1")]),
      fetch: { TE1: fetched({ attachmentNames: ["見積.pdf"], failures: [{ index: 1, name: "見積.pdf", code: "TIME_BUDGET_EXCEEDED", reason: "時間の上限", retryable: true }] }) },
      attachment: () => new RakurakuApiError("ATTACHMENT_MISMATCH", "伝票の添付が変わっています"),
    });
    expect(status.pending).toHaveLength(1);
    const records = await readRecords(s.store, tenmatsu);
    expect(records.pending.TE1.missing[0].reason).toBe("伝票の添付が変わっています");
  });
});

describe("本体PDFが取れない", () => {
  const bodyFailed = () => new RakurakuApiError("BODY_PDF_FAILED", "本体PDFを取れませんでした（「印刷」から本体PDFを取得できませんでした）", true);

  it("★その伝票だけ見送り、記録にも保留にも残さない（次回やり直す）", async () => {
    const s = setup();
    const { status, log } = await run(s, { scan: scanOf([target("TE1"), target("TE2")]), fetch: { TE1: bodyFailed(), TE2: fetched() } });
    expect(status.state).toBe("done");
    expect(status.skipped).toEqual(["TE1"]);
    expect(status.processed).toBe(1);
    const records = await readRecords(s.store, tenmatsu);
    expect(records.done).toEqual(["TE2"]);
    expect(records.pending).toEqual({});
    expect(log).toContain("  ! この伝票は見送ります（次回の取得でやり直します）");
  });

  it("★続けて2件取れなければ止め、何が起きたかを _記録/エラー_*.txt に残す", async () => {
    const s = setup();
    const { status } = await run(s, { scan: scanOf([target("TE1"), target("TE2"), target("TE3")]), fetch: { TE1: bodyFailed(), TE2: bodyFailed(), TE3: fetched() } });
    expect(status.state).toBe("error");
    expect(status.error).toContain("本体PDFの取得が続けて失敗しました");
    expect(status.error_file).toBe("_記録/エラー_20260913_110000.txt");
    const report = s.fs.text("_記録/エラー_20260913_110000.txt")!;
    expect(report).toContain("処理中だった伝票№: TE2");
    expect(report).toContain("見送り: 2件 TE1, TE2");
  });
});

describe("ログイン", () => {
  it("★ログインが切れたら、登録した控えで1回だけログインし直して同じ伝票をやり直す", async () => {
    const s = setup();
    const expired = new RakurakuApiError("SESSION_EXPIRED", "楽楽精算のログインが切れました", false, true);
    const { status, api, log } = await run(s, { scan: scanOf([target("TE1")]), fetch: { TE1: [expired, fetched()] } });
    expect(status.state).toBe("done");
    expect(status.processed).toBe(1);
    expect(api.calls.map((c) => c.method)).toEqual(["scan", "fetch", "login", "fetch"]);
    expect(log.some((l) => l.includes("1回だけログインし直して"))).toBe(true);
  });

  it("★2回目に切れたら、もうログインし直さずに止める（アカウントロックを避ける）", async () => {
    const s = setup();
    const expired = new RakurakuApiError("SESSION_EXPIRED", "楽楽精算のログインが切れました", false, true);
    const { status, api } = await run(s, { scan: scanOf([target("TE1"), target("TE2")]), fetch: { TE1: [expired, fetched()], TE2: expired } });
    expect(status.state).toBe("error");
    expect(api.calls.filter((c) => c.method === "login")).toHaveLength(1);
    expect((await readRecords(s.store, tenmatsu)).done).toEqual(["TE1"]);
  });

  it("このPCに登録が無ければ、ログインし直せずに止める（楽楽精算へは送らない）", async () => {
    const s = setup({ registered: false });
    const expired = new RakurakuApiError("SESSION_EXPIRED", "楽楽精算のログインが切れました", false, true);
    const { status, api } = await run(s, { scan: expired });
    expect(status.state).toBe("error");
    expect(api.calls.filter((c) => c.method === "login")).toHaveLength(0);
    expect(s.auth.tokenValue).toBeNull();
  });

  it("まだログインしていなければ、最初に登録した控えでログインする。登録が無ければ理由を出して止める", async () => {
    const s = setup({ token: null });
    const { api } = await run(s, { scan: scanOf([]) });
    expect(api.calls.map((c) => c.method)).toEqual(["login", "scan"]);
    // ★送るのは控えだけ（ID とパスワードは送らない）
    expect(api.calls[0].request).toEqual({ credential: "sealed-credential" });
    const none = await run(setup({ token: null, registered: false }), { scan: scanOf([]) });
    expect(none.status.error).toContain("登録されていません");
  });

  it("★1回の取得でログインするのは2回まで（最初の1回＋切れたときの1回）", async () => {
    const s = setup({ token: null });
    const expired = new RakurakuApiError("SESSION_EXPIRED", "楽楽精算のログインが切れました", false, true);
    const { status, api } = await run(s, { scan: () => expired });
    expect(status.state).toBe("error");
    expect(api.calls.filter((c) => c.method === "login").length).toBeLessThanOrEqual(2);
  });

  it("★ログインに失敗したら、やり直さずに止める", async () => {
    const s = setup({ token: null });
    const { status, api } = await run(s, { login: () => new RakurakuApiError("LOGIN_FAILED", "ログインできませんでした。やり直しません"), scan: scanOf([]) });
    expect(status.error).toContain("やり直しません");
    expect(api.calls.map((c) => c.method)).toEqual(["login"]);
  });

  it("流れてきた新しいログイン状態を覚える", async () => {
    const s = setup();
    await run(s, { scan: scanOf([]) });
    expect(s.auth.tokenValue).toMatch(/^refreshed-/);
  });
});

describe("止める・画面へ伝える", () => {
  it("★中止は「いまの伝票が終わったら止める」。残りは次回取得すると伝える", async () => {
    const s = setup();
    const api = createFakeApi({ scan: scanOf([target("TE1"), target("TE2"), target("TE3")]), fetch: { TE1: fetched(), TE2: fetched(), TE3: fetched() } });
    let handleRef: ReturnType<typeof startRun> | null = null;
    handleRef = startRun(
      {
        store: s.store,
        cfg: tenmatsu,
        api,
        auth: s.auth,
        deptCode: null,
        now: () => NOW,
        sleep: async () => {
          handleRef?.abort(); // 1件目のあとで中止を押した
        },
      },
      { limit: 10 },
    );
    const status = await handleRef.finished;
    expect(status.state).toBe("done");
    expect(status.processed).toBe(1);
    expect(status.remaining).toBe(2);
    expect(api.calls.filter((c) => c.method === "fetch")).toHaveLength(1);
  });

  it("状態の変化を知らせ、since より後の行だけを返す", async () => {
    const s = setup();
    const { handle, updates } = await run(s, { scan: scanOf([target("TE1")]), fetch: { TE1: fetched() }, logs: ["  1ページ目: 1行"] });
    expect(updates.length).toBeGreaterThan(3);
    expect(updates.at(-1)?.state).toBe("done");
    const all = handle.snapshot(0).log!;
    expect(handle.snapshot(all.length - 1).log).toEqual([all.at(-1)]);
    expect(handle.snapshot().log).toBeUndefined();
    expect(all.map((l) => l.text)).toContain("  1ページ目: 1行");
  });

});

describe("部門を選べずに止まったとき", () => {
  it("★符号と「選べる部門」を画面へ渡す（画面が選択肢を直せるように）", async () => {
    const s = setup();
    const available = [
      { code: "1800", label: "アフターメンテナンス課(1800)" },
      { code: "1900", label: "架空の課(1900)" },
    ];
    const { status } = await run(s, {
      scan: new RakurakuApiError("DEPT_NOT_AVAILABLE", "部門「1800」は選べません", false, false, available),
    });
    expect(status.state).toBe("error");
    expect(status.error_code).toBe("DEPT_NOT_AVAILABLE");
    expect(status.error_departments).toEqual(available);
  });

  it("選べる部門が分からない失敗には、余計な項目を付けない", async () => {
    const s = setup();
    const { status } = await run(s, {
      scan: new RakurakuApiError("DEPT_SELECT_MISSING", "部門の切り替えが見つかりません"),
    });
    expect(status.error_code).toBe("DEPT_SELECT_MISSING");
    expect(status.error_departments).toBeUndefined();
  });

  it("楽楽精算と関係のない失敗には符号を付けない（古いサーバーと同じ形）", async () => {
    const s = setup();
    const { status } = await run(s, { scan: new Error("なにかの不具合") });
    expect(status.state).toBe("error");
    expect(status.error_code).toBeUndefined();
  });
});

describe("混み合っているとき", () => {
  it("★Folio のサーバーが混み合っていたら、少し待ってやり直す（楽楽精算には触っていないので安全）", async () => {
    const s = setup();
    const busy = new RakurakuApiError("BROWSER_BUSY", "混み合っています", true);
    let scans = 0;
    const { status, log } = await run(s, {
      scan: () => (++scans === 1 ? busy : scanOf([])),
    });
    expect(status.state).toBe("done");
    expect(scans).toBe(2);
    expect(s.sleeps).toContain(20_000);
    expect(log.some((l) => l.includes("混み合っているので"))).toBe(true);
  });

  it("何度待っても混み合っていれば、理由を出して止める", async () => {
    const s = setup();
    const { status } = await run(s, { scan: new RakurakuApiError("BROWSER_BUSY", "混み合っています", true) });
    expect(status.state).toBe("error");
    expect(status.error).toContain("混み合っています");
  });
});
