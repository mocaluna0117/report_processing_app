import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchedBrowser } from "@/lib/rakuraku/browser";
import { RakurakuError, browserGoneError } from "@/lib/rakuraku/errors";
import type { SessionPayload } from "@/lib/rakuraku/session";
import type { EventSink } from "@/lib/rakuraku/stream";

// 2026-10-01、取得（scan / fetch）だけが開始から1秒以内に TARGET_CLOSED で止まり続けた。
// トップを開く段階でこちらのブラウザが落ちたときだけ、起こし直して1回だけやり直す。
// ★この段階では楽楽精算へログインも送信もしていないので、アカウントのロックの決まりに触れない。

const launches: { closed: number }[] = [];
const launchBrowser = vi.fn(async (): Promise<LaunchedBrowser> => {
  const record = { closed: 0 };
  launches.push(record);
  const seq = launches.length;
  const context = {
    newPage: async () => ({ setDefaultTimeout: () => undefined }),
    storageState: async () => ({ cookies: [], origins: [] }),
  };
  return {
    browser: { newContext: async () => context } as unknown as LaunchedBrowser["browser"],
    profileDir: "/tmp/x",
    close: async () => {
      record.closed += 1;
    },
    diagnostics: () => ({ n_launch_seq: seq, ms_instance_up: 1 }),
  };
});
vi.mock("@/lib/rakuraku/browser", () => ({ launchBrowser: () => launchBrowser() }));

const openHome = vi.fn<() => Promise<void>>();
vi.mock("@/lib/rakuraku/navigation", () => ({ openHome: () => openHome() }));
vi.mock("@/lib/rakuraku/session", () => ({ reseal: () => "新しい札" }));

const { withSessionPage } = await import("@/lib/rakuraku/session-browser");

const session = { state: "{}", home: "https://example.test/top", routes: {} } as unknown as SessionPayload;
const tenant = { loginUrl: "https://example.test/" };

function fakeSink() {
  const aborter = new AbortController();
  const notes: Record<string, unknown> = {};
  const lines: string[] = [];
  const sink: EventSink = {
    send: async () => undefined,
    log: (line) => void lines.push(line),
    progress: () => undefined,
    onAbort: () => undefined,
    note: (fields) => void Object.assign(notes, fields),
    signal: aborter.signal,
  };
  return { sink, notes, lines };
}

beforeEach(() => {
  launches.length = 0;
  launchBrowser.mockClear();
  openHome.mockReset();
});

describe("トップでブラウザが落ちたら、1回だけ起こし直す", () => {
  it("★2回目で開ければ、処理はそのまま1回だけ走る", async () => {
    openHome.mockRejectedValueOnce(browserGoneError(new Error("Target page, context or browser has been closed")));
    openHome.mockResolvedValue(undefined);
    const { sink, notes, lines } = fakeSink();
    const run = vi.fn(async () => undefined);

    await withSessionPage(sink, session, run, { tenant });

    expect(launches.length).toBe(2);
    expect(run).toHaveBeenCalledTimes(1);
    // ★どちらのブラウザも1回ずつ閉じる（空き枠を2回返さない・閉じ忘れない）
    expect(launches.map((l) => l.closed)).toEqual([1, 1]);
    expect(lines.join("\n")).toContain("起こし直して");
    expect(notes).toMatchObject({ n_relaunch: 1, n_first_launch_seq: 1, n_launch_seq: 2 });
  });

  it("★2回目も落ちたら、そのまま失敗を返す（3回目は無い）", async () => {
    openHome.mockRejectedValue(browserGoneError(new Error("Target closed")));
    const { sink } = fakeSink();
    const run = vi.fn(async () => undefined);

    const error = await withSessionPage(sink, session, run, { tenant }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RakurakuError);
    expect((error as RakurakuError).detail).toBe("TARGET_CLOSED");
    expect(launches.length).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(launches.map((l) => l.closed)).toEqual([1, 1]);
  });

  it("★楽楽精算に繋がらない・ログインが切れた、は起こし直さない", async () => {
    for (const e of [
      new RakurakuError("TENANT_UNREACHABLE", "繋がりません", { retryable: true, detail: "net::ERR_CONNECTION_RESET" }),
      new RakurakuError("SESSION_EXPIRED", "切れました", { sessionLost: true }),
    ]) {
      launches.length = 0;
      openHome.mockReset();
      openHome.mockRejectedValue(e);
      const { sink } = fakeSink();
      await expect(withSessionPage(sink, session, async () => undefined, { tenant })).rejects.toBe(e);
      expect(launches.length).toBe(1);
      expect(launches[0].closed).toBe(1);
    }
  });

  it("tenant を渡さなければ、今までどおりトップを先に開かない", async () => {
    const { sink, notes } = fakeSink();
    const run = vi.fn(async () => undefined);
    await withSessionPage(sink, session, run);
    expect(openHome).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(launches.map((l) => l.closed)).toEqual([1]);
    // 成功したときも、何回目の起動かは残す（壊れたインスタンスの見分けに使う）
    expect(notes).toMatchObject({ n_launch_seq: 1 });
  });
});
