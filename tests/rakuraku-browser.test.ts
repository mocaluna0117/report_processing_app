import { describe, expect, it } from "vitest";
import { browserLaunchError, isTextFileBusy, retryOnTextFileBusy, sharedOnce } from "@/lib/rakuraku/browser";

// ブラウザを起こすところの取り決め（2026-09-22）。
// ★本番で「部門を読み込めませんでした (browserType.launch: spawn ETXTBSY)」が出た。
//   Vercel は Chromium を /tmp へ展開してから起こすが、@sparticuz/chromium は
//   「ファイルが在る」だけで展開済みとみなすので、展開の途中に起こすと**中身が空のファイル**を
//   実行してしまう。展開をインスタンスごとに1回だけにまとめ、掴んだときは待ってやり直す。

const busy = () => new Error("browserType.launch: spawn ETXTBSY");
const noWait = async () => {};

describe("書きかけの実行ファイルを見分ける", () => {
  it("ETXTBSY なら true（Error でも文字列でも）", () => {
    expect(isTextFileBusy(busy())).toBe(true);
    expect(isTextFileBusy("spawn ETXTBSY")).toBe(true);
  });

  it("ほかの失敗は false（何でもやり直さない）", () => {
    expect(isTextFileBusy(new Error("Executable doesn't exist"))).toBe(false);
    expect(isTextFileBusy(new Error("Timeout 45000ms exceeded"))).toBe(false);
    expect(isTextFileBusy(null)).toBe(false);
  });
});

describe("掴んだときだけ、待って1回やり直す", () => {
  it("2回目で起きれば、その結果を返す", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      if (calls === 1) throw busy();
      return "起きました";
    };
    expect(await retryOnTextFileBusy(run, 10, noWait)).toBe("起きました");
    expect(calls).toBe(2);
  });

  it("★やり直すのは1回だけ（待ち行列を自分で伸ばさない）", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      throw busy();
    };
    await expect(retryOnTextFileBusy(run, 10, noWait)).rejects.toThrow("ETXTBSY");
    expect(calls).toBe(2);
  });

  it("★ほかの失敗はやり直さず、そのまま返す", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      throw new Error("Executable doesn't exist");
    };
    await expect(retryOnTextFileBusy(run, 10, noWait)).rejects.toThrow("Executable");
    expect(calls).toBe(1);
  });

  it("待ってからやり直す（すぐ掴み直さない）", async () => {
    const waited: number[] = [];
    let calls = 0;
    const run = async () => {
      calls += 1;
      if (calls === 1) throw busy();
      return true;
    };
    await retryOnTextFileBusy(run, 3_000, async (ms) => {
      waited.push(ms);
    });
    expect(waited).toEqual([3_000]);
  });

  it("一度で起きれば待たない", async () => {
    const waited: number[] = [];
    await retryOnTextFileBusy(async () => true, 3_000, async (ms) => {
      waited.push(ms);
    });
    expect(waited).toEqual([]);
  });
});

describe("展開はインスタンスごとに1回だけ", () => {
  it("★同時に呼ばれても展開は1回（これが無いと、書きかけを起こして ETXTBSY になる）", async () => {
    let started = 0;
    let release: (v: string) => void = () => {};
    const once = sharedOnce(() => {
      started += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    const a = once();
    const b = once();
    release("/tmp/chromium");
    expect(await a).toBe("/tmp/chromium");
    expect(await b).toBe("/tmp/chromium");
    expect(started).toBe(1);
  });

  it("一度できたら、次からは展開し直さない", async () => {
    let started = 0;
    const once = sharedOnce(async () => {
      started += 1;
      return "/tmp/chromium";
    });
    await once();
    await once();
    expect(started).toBe(1);
  });

  it("★失敗は覚えない（次の呼び出しでやり直せる）", async () => {
    let started = 0;
    const once = sharedOnce(async () => {
      started += 1;
      if (started === 1) throw new Error("展開に失敗");
      return "/tmp/chromium";
    });
    await expect(once()).rejects.toThrow("展開に失敗");
    expect(await once()).toBe("/tmp/chromium");
    expect(started).toBe(2);
  });
});

describe("起こせなかったときの知らせ", () => {
  it("★生の英語をそのまま画面に出さない", () => {
    const error = browserLaunchError(busy());
    expect(error.message).not.toContain("ETXTBSY");
    expect(error.message).not.toContain("browserType");
    expect(error.message).toContain("少し待ってからもう一度");
  });

  it("書きかけを掴んだときは、準備が終わっていないと伝える", () => {
    expect(browserLaunchError(busy()).message).toContain("準備");
  });

  it("★楽楽精算に触る前の失敗なので、やり直してよい印を付ける", () => {
    const error = browserLaunchError(busy());
    expect(error.code).toBe("BROWSER_LAUNCH_FAILED");
    expect(error.retryable).toBe(true);
    // ★ログインし直しは要らない（ログインはまだ1回も試していない）
    expect(error.sessionLost).toBe(false);
  });

  it("ほかの失敗でも、何が起きたかの手がかりは残す", () => {
    const error = browserLaunchError(new TypeError("boom"));
    expect(error.message).toContain("TypeError");
    expect(error.code).toBe("BROWSER_LAUNCH_FAILED");
  });
});
