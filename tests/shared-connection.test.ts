import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConnectionDeps,
  SYNC_DEBOUNCE_MS,
  SYNC_ON_OPEN_FRESH_MS,
  chooseSharedFolder,
  connectSharedFolder,
  forgetSharedFolder,
  getSharedConnection,
  onSharedSynced,
  resetSharedConnectionForTests,
  restoreSharedConnection,
  scheduleSharedSync,
  syncSharedNow,
  wantSharedSync,
} from "@/lib/shared/connection";
import type { SharedFolder } from "@/lib/shared/folder";
import type { SyncReport } from "@/lib/shared/sync";
import type { BrowserDirHandle } from "@/lib/tenmatsu/local/folder-handle";

// 共有フォルダーのつながりを Folio 全体で1つにした（2026-09-23）。
// ★守ること: 読み込み直後は許可を尋ねない／共有データを使わない画面（専決・捺印）では
//   自動で同期しない／続けて直しても同期は1回にまとめる／途中で頼まれた同期を取りこぼさない。

const NOW = 1_800_000_000_000;
const HANDLE = { name: "Folio共有" } as BrowserDirHandle;
const FOLDER = {} as SharedFolder;

const report = (over: Partial<SyncReport> = {}): SyncReport => ({
  at: NOW,
  awaitingFirstWrite: false,
  pending: { customers: 0, examples: { inquiry: 0, inspection: 0 } },
  customers: { applied: 0, unmatched: 0, written: false },
  examples: { inquiry: { count: 0, written: false }, inspection: { count: 0, written: false } },
  ledger: { imported: [], pending: [], skipped: [], conflicts: [] },
  customerLedger: { count: 0, applied: 0, written: false },
  failures: [],
  ...over,
});

/** 外とのやり取りの作り物。呼ばれた回数を数える */
function fakes(over: Partial<ConnectionDeps> = {}) {
  let lastSync: number | null = null;
  const deps = {
    supported: vi.fn(() => true),
    storageAvailable: vi.fn(() => true),
    loadHandle: vi.fn(async () => HANDLE as BrowserDirHandle | null),
    saveHandle: vi.fn(async () => undefined),
    clearHandle: vi.fn(async () => undefined),
    loadLastSync: vi.fn(async () => lastSync),
    queryPermission: vi.fn(async (): Promise<PermissionState> => "granted"),
    ensurePermission: vi.fn(async () => undefined),
    pick: vi.fn(async () => HANDLE as BrowserDirHandle | null),
    open: vi.fn(async () => FOLDER),
    sync: vi.fn(async () => {
      lastSync = NOW;
      return report();
    }),
    now: vi.fn(() => NOW),
    ...over,
  };
  resetSharedConnectionForTests(deps);
  return {
    deps,
    setLastSync: (at: number | null) => {
      lastSync = at;
    },
  };
}

/** 保留中の Promise を流しきる */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetSharedConnectionForTests();
});

describe("読み込んだ直後", () => {
  it("まだ選んでいなければ「未設定」になり、何も尋ねない", async () => {
    const { deps } = fakes({ loadHandle: vi.fn(async () => null) });
    expect(getSharedConnection().known).toBe(false);
    await restoreSharedConnection();
    expect(getSharedConnection()).toMatchObject({ known: true, state: "none" });
    expect(deps.queryPermission).not.toHaveBeenCalled();
    expect(deps.ensurePermission).not.toHaveBeenCalled();
  });

  it("★許可が生きていれば、尋ねずにつなぐ", async () => {
    const { deps } = fakes();
    await restoreSharedConnection();
    expect(getSharedConnection()).toMatchObject({ state: "connected", folderName: "Folio共有" });
    expect(deps.ensurePermission).not.toHaveBeenCalled();
  });

  it("★許可が切れていれば、つながずに「つなぐ」を押してもらう（requestPermission は呼ばない）", async () => {
    const { deps } = fakes({ queryPermission: vi.fn(async (): Promise<PermissionState> => "prompt") });
    await restoreSharedConnection();
    expect(getSharedConnection()).toMatchObject({ state: "prompt", folderName: "Folio共有" });
    expect(deps.ensurePermission).not.toHaveBeenCalled();
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("何度呼んでも読むのは1回（ヘッダーと画面の両方から呼ばれる）", async () => {
    const { deps } = fakes();
    await Promise.all([restoreSharedConnection(), restoreSharedConnection()]);
    await restoreSharedConnection();
    expect(deps.loadHandle).toHaveBeenCalledTimes(1);
    expect(deps.open).toHaveBeenCalledTimes(1);
  });

  it("このブラウザで使えなければ「使えない」にする", async () => {
    const { deps } = fakes({ supported: vi.fn(() => false) });
    await restoreSharedConnection();
    expect(getSharedConnection()).toMatchObject({ known: true, state: "unsupported" });
    expect(deps.loadHandle).not.toHaveBeenCalled();
  });
});

describe("画面を開いたときの同期", () => {
  it("共有データを使う画面が開いていれば、つないだあとに同期する", async () => {
    const { deps } = fakes();
    wantSharedSync();
    await restoreSharedConnection();
    await settle();
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(deps.sync).toHaveBeenCalledWith(FOLDER, {});
    expect(getSharedConnection().lastSync).toBe(NOW);
  });

  it("★専決決裁書・捺印決裁書（使う画面が無い）では、つないでも同期しない", async () => {
    const { deps } = fakes();
    await restoreSharedConnection();
    await settle();
    expect(getSharedConnection().state).toBe("connected");
    expect(deps.sync).not.toHaveBeenCalled();
  });

  it("タブを移ってきたとき、前回の同期から間が空いていれば同期する", async () => {
    const { deps, setLastSync } = fakes();
    setLastSync(NOW - SYNC_ON_OPEN_FRESH_MS);
    await restoreSharedConnection();
    wantSharedSync();
    await settle();
    expect(deps.sync).toHaveBeenCalledTimes(1);
  });

  it("★タブを行き来しただけ（前回の同期がすぐ前）なら、読みに行かない", async () => {
    const { deps, setLastSync } = fakes();
    setLastSync(NOW - SYNC_ON_OPEN_FRESH_MS + 1_000);
    await restoreSharedConnection();
    wantSharedSync();
    await settle();
    expect(deps.sync).not.toHaveBeenCalled();
  });

  it("画面を閉じたら、次に読み込んだときは同期しない", async () => {
    const { deps } = fakes();
    const release = wantSharedSync();
    release();
    release(); // 2回呼んでも数を減らしすぎない
    await restoreSharedConnection();
    await settle();
    expect(deps.sync).not.toHaveBeenCalled();
  });

  it("このタブで保存できないときは同期しない", async () => {
    const { deps } = fakes({ storageAvailable: vi.fn(() => false) });
    wantSharedSync();
    await restoreSharedConnection();
    await settle();
    expect(deps.sync).not.toHaveBeenCalled();
  });
});

describe("ボタンで選ぶ・つなぐ", () => {
  it("選んだら覚えて、許可をもらってつなぎ、すぐ同期する", async () => {
    const { deps } = fakes({ loadHandle: vi.fn(async () => null) });
    await restoreSharedConnection();
    await chooseSharedFolder();
    expect(deps.saveHandle).toHaveBeenCalledWith(HANDLE);
    expect(deps.ensurePermission).toHaveBeenCalledWith(HANDLE);
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(getSharedConnection()).toMatchObject({ state: "connected", folderName: "Folio共有" });
  });

  it("選ぶのをやめたら何もしない", async () => {
    const { deps } = fakes({ loadHandle: vi.fn(async () => null), pick: vi.fn(async () => null) });
    await restoreSharedConnection();
    await chooseSharedFolder();
    expect(deps.saveHandle).not.toHaveBeenCalled();
    expect(getSharedConnection().state).toBe("none");
  });

  it("「つなぐ」を押したら許可を尋ね、つないで同期する（使わない画面からでも）", async () => {
    const { deps } = fakes({ queryPermission: vi.fn(async (): Promise<PermissionState> => "prompt") });
    await restoreSharedConnection();
    await connectSharedFolder();
    expect(deps.ensurePermission).toHaveBeenCalledTimes(1);
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(getSharedConnection().state).toBe("connected");
  });

  it("つなげなかったら、理由を出して「使えない」にする", async () => {
    fakes({
      queryPermission: vi.fn(async (): Promise<PermissionState> => "prompt"),
      ensurePermission: vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      }),
    });
    await restoreSharedConnection();
    await connectSharedFolder();
    expect(getSharedConnection().state).toBe("error");
    expect(getSharedConnection().error).toBeTruthy();
  });

  it("初回の書き出し・顧客ファイルの入れ替えは、ボタンで許したときだけ渡す", async () => {
    const { deps } = fakes();
    await restoreSharedConnection();
    await syncSharedNow({ allowFirstWrite: true });
    await syncSharedNow({ allowLedgerReplace: true });
    expect(deps.sync).toHaveBeenNthCalledWith(1, FOLDER, { allowFirstWrite: true });
    expect(deps.sync).toHaveBeenNthCalledWith(2, FOLDER, { allowLedgerReplace: true });
  });
});

describe("直したあとの同期", () => {
  it("続けて直しても、少し待って1回にまとめる", async () => {
    const { deps } = fakes();
    await restoreSharedConnection();
    scheduleSharedSync();
    scheduleSharedSync();
    scheduleSharedSync();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS - 1);
    expect(deps.sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(deps.sync).toHaveBeenCalledTimes(1);
    expect(deps.sync).toHaveBeenCalledWith(FOLDER, {});
  });

  it("つないでいなければ何もしない", async () => {
    const { deps } = fakes({ queryPermission: vi.fn(async (): Promise<PermissionState> => "prompt") });
    await restoreSharedConnection();
    scheduleSharedSync();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
    expect(deps.sync).not.toHaveBeenCalled();
  });

  it("★同期の途中で頼まれた分は、終わってからもう1回だけ回す（直した分を取りこぼさない）", async () => {
    let finish: (value: SyncReport) => void = () => undefined;
    const sync = vi
      .fn<ConnectionDeps["sync"]>()
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValue(report());
    const { deps } = fakes({ sync });
    await restoreSharedConnection();
    const first = syncSharedNow();
    await settle();
    expect(getSharedConnection().syncing).toBe(true);
    void syncSharedNow();
    void syncSharedNow();
    finish(report());
    await first;
    await settle();
    expect(deps.sync).toHaveBeenCalledTimes(2);
    expect(getSharedConnection().syncing).toBe(false);
  });
});

describe("同期が済んだら画面に知らせる", () => {
  it("どこから始めた同期でも、開いている画面に結果を渡す", async () => {
    const got: SyncReport[] = [];
    const done = report({ customers: { applied: 2, unmatched: 0, written: true } });
    fakes({ sync: vi.fn(async () => done) });
    onSharedSynced((r) => {
      got.push(r);
    });
    await restoreSharedConnection();
    await syncSharedNow();
    expect(got).toEqual([done]);
    expect(getSharedConnection().report).toBe(done);
  });

  it("読み直しに失敗した画面があっても、ほかの画面には知らせる", async () => {
    const seen = vi.fn();
    fakes();
    onSharedSynced(() => {
      throw new Error("読めません");
    });
    onSharedSynced(seen);
    await restoreSharedConnection();
    await syncSharedNow();
    expect(seen).toHaveBeenCalledTimes(1);
    expect(getSharedConnection().state).toBe("connected");
  });

  it("同期に失敗したら理由を出し、次に成功したら「つながっている」に戻す", async () => {
    const sync = vi
      .fn<ConnectionDeps["sync"]>()
      .mockRejectedValueOnce(new Error("Box が応答しません"))
      .mockResolvedValue(report());
    fakes({ sync });
    await restoreSharedConnection();
    await syncSharedNow();
    expect(getSharedConnection().state).toBe("error");
    expect(getSharedConnection().error).toContain("Box が応答しません");
    await syncSharedNow();
    expect(getSharedConnection()).toMatchObject({ state: "connected", error: null });
  });
});

describe("登録を消す", () => {
  it("消したらつながりを外し、予約していた同期もやめる（フォルダーの中は消さない）", async () => {
    const { deps } = fakes();
    await restoreSharedConnection();
    scheduleSharedSync();
    await forgetSharedFolder();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
    expect(deps.clearHandle).toHaveBeenCalledTimes(1);
    expect(deps.sync).not.toHaveBeenCalled();
    expect(getSharedConnection()).toMatchObject({ state: "none", folderName: null, report: null });
  });

  it("つないでいる途中で消したら、あとからつながらない", async () => {
    let opened: (folder: SharedFolder) => void = () => undefined;
    fakes({ open: vi.fn(() => new Promise<SharedFolder>((resolve) => (opened = resolve))) });
    const restoring = restoreSharedConnection();
    await settle();
    expect(getSharedConnection().state).toBe("connecting");
    await forgetSharedFolder();
    opened(FOLDER);
    await restoring;
    expect(getSharedConnection().state).toBe("none");
  });

  it("消せなかったら理由を出す", async () => {
    fakes({
      clearHandle: vi.fn(async () => {
        throw new Error("容量が足りません");
      }),
    });
    await restoreSharedConnection();
    await forgetSharedFolder();
    expect(getSharedConnection().error).toContain("容量が足りません");
  });
});

describe("どの画面が開いたときに同期を頼むか（画面のテスト基盤が無いので、中身を読んで見張る）", () => {
  const source = (path: string) => readFileSync(resolve(__dirname, "..", path), "utf8");

  it("定期点検は頼む", () => {
    expect(source("app/page.tsx")).toContain("useSharedSyncOnOpen();");
  });

  it("アフターは頼む（useSharedFolder の中で頼む）", () => {
    expect(source("components/after/after-page.tsx")).toContain("useSharedFolder({");
    expect(source("lib/shared/use-shared-folder.ts")).toMatch(/export function useSharedFolder\([\s\S]*?useSharedSyncOnOpen\(\);/);
  });

  it("★顛末書系の画面は、監督・営業を反映する種類（顛末書）だけが頼む", () => {
    expect(source("components/tenmatsu/tenmatsu-folder-page.tsx")).toContain(
      "useSharedSyncOnOpen(kind.showStaffSync);",
    );
  });

  it("★ヘッダーは頼まない（つなぐだけ。専決・捺印で同期しないため）", () => {
    const nav = source("components/mode-nav.tsx");
    expect(nav).not.toContain("wantSharedSync");
    expect(nav).not.toContain("useSharedSyncOnOpen");
  });
});
