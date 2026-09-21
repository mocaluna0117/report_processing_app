import { describe, expect, it } from "vitest";
import type { DepartmentOption } from "@/lib/rakuraku/protocol";
import type { StatusPayload } from "@/lib/tenmatsu/client";
import {
  DEPT_RETRY_WAIT_MS,
  departmentErrorText,
  departmentFixFromStatus,
  isRetryableDeptError,
  pickDepartment,
  readDepartments,
  shouldAutoLoadDepartments,
} from "@/lib/tenmatsu/local/departments";
import { type ApiCode, RakurakuApiError } from "@/lib/tenmatsu/local/server-api";

/** 架空の部門（実在の値は使わない） */
const AFTER: DepartmentOption = { code: "1800", label: "アフターメンテナンス課(1800)" };
const QUALITY: DepartmentOption = { code: "1900", label: "品質管理部(1900)" };

type Answer =
  | { departments: DepartmentOption[]; current: DepartmentOption | null; hasDepartmentSelect: boolean }
  | RakurakuApiError;

/** 台本どおりに答える作り物。呼ばれた回数と待ち時間を数える */
function fake(answers: Answer[]) {
  const waits: number[] = [];
  let calls = 0;
  const api = {
    departments: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)];
      calls += 1;
      if (answer instanceof RakurakuApiError) throw answer;
      return { ...answer, sessionToken: `token-${calls}`, expiresAt: null };
    },
  };
  return {
    deps: {
      api,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    },
    waits,
    get calls() {
      return calls;
    },
  };
}

const err = (code: ApiCode, retryable = false, sessionLost = false) =>
  new RakurakuApiError(code, `${code} が起きました`, retryable, sessionLost);

describe("やり直してよい失敗かを見分ける", () => {
  it.each<ApiCode>(["INTERNAL", "BROWSER_BUSY", "BROWSER_LAUNCH_FAILED", "TENANT_UNREACHABLE", "NETWORK", "STREAM_CUT"])(
    "%s はやり直す（楽楽精算に何も送っていない）",
    (code) => {
      expect(isRetryableDeptError(err(code))).toBe(true);
    },
  );

  it.each<ApiCode>(["SESSION_EXPIRED", "DEPT_SELECT_MISSING", "UNAUTHORIZED", "DISABLED", "BAD_REQUEST", "LOGIN_FAILED"])(
    "%s はやり直さない",
    (code) => {
      expect(isRetryableDeptError(err(code))).toBe(false);
    },
  );

  it("サーバーが「やり直してよい」と言えばやり直す", () => {
    expect(isRetryableDeptError(err("DETAIL_NOT_FOUND", true))).toBe(true);
  });

  it("★ログインし直しが要る失敗は、やり直してよいと言われても やり直さない", () => {
    expect(isRetryableDeptError(err("SESSION_EXPIRED", true, true))).toBe(false);
  });

  it("楽楽精算の失敗でないものはやり直さない", () => {
    expect(isRetryableDeptError(new Error("なにか"))).toBe(false);
  });
});

describe("部門を読む", () => {
  it("プルダウンが無いアカウントは「指定せずに取得してよい」を返す", async () => {
    const f = fake([{ departments: [], current: null, hasDepartmentSelect: false }]);
    expect(await readDepartments(f.deps, "t")).toMatchObject({ kind: "none" });
    expect(f.calls).toBe(1);
  });

  it("★プルダウンはあるが選択肢が空のときは、それと分けて返す", async () => {
    const f = fake([{ departments: [], current: null, hasDepartmentSelect: true }]);
    expect(await readDepartments(f.deps, "t")).toMatchObject({ kind: "empty" });
  });

  it("選べる部門が読めたらそのまま返す", async () => {
    const f = fake([{ departments: [AFTER, QUALITY], current: QUALITY, hasDepartmentSelect: true }]);
    expect(await readDepartments(f.deps, "t")).toMatchObject({
      kind: "list",
      departments: [AFTER, QUALITY],
      current: QUALITY,
      sessionToken: "token-1",
    });
  });

  it("★一時的な失敗は1回だけ待ってやり直す", async () => {
    const f = fake([err("INTERNAL"), { departments: [AFTER], current: AFTER, hasDepartmentSelect: true }]);
    expect(await readDepartments(f.deps, "t")).toMatchObject({ kind: "list" });
    expect(f.calls).toBe(2);
    expect(f.waits).toEqual([DEPT_RETRY_WAIT_MS]);
  });

  it("★やり直すのは1回だけ（延々と繰り返さない）", async () => {
    const f = fake([err("INTERNAL")]);
    expect(await readDepartments(f.deps, "t")).toMatchObject({ kind: "failed", code: "INTERNAL", attempts: 2 });
    expect(f.calls).toBe(2);
    expect(f.waits).toHaveLength(1);
  });

  it("ログインが切れていたらやり直さず、ログインし直しが要ると伝える", async () => {
    const f = fake([err("SESSION_EXPIRED", false, true)]);
    expect(await readDepartments(f.deps, "t")).toMatchObject({ kind: "failed", sessionLost: true, attempts: 1 });
    expect(f.calls).toBe(1);
  });

  it("古いサーバーの「プルダウンが無い」も、正常な状態として扱う", async () => {
    const f = fake([err("DEPT_SELECT_MISSING")]);
    expect(await readDepartments(f.deps, "t")).toMatchObject({ kind: "none", sessionToken: null });
    expect(f.calls).toBe(1);
  });

  it("読めなかったときの文は、今までと同じ言い方にする", () => {
    expect(
      departmentErrorText({ kind: "failed", code: "INTERNAL", message: "画面を開けません", sessionLost: false, attempts: 2 }),
    ).toBe("部門を読み込めませんでした (画面を開けません)");
  });
});

describe("画面が勝手に部門を読みに行ってよいか", () => {
  const idle = {
    loggedIn: true,
    loaded: false,
    busy: false,
    failed: false,
    skipped: false,
    tried: false,
  };

  it("ログインできていて、まだ読んでいなければ読みに行く", () => {
    expect(shouldAutoLoadDepartments(idle)).toBe(true);
  });

  it("ログインしていなければ読みに行かない（楽楽精算に触らない）", () => {
    expect(shouldAutoLoadDepartments({ ...idle, loggedIn: false })).toBe(false);
  });

  it("★一度失敗したら、自動では読み直さない（押したときだけ）", () => {
    expect(shouldAutoLoadDepartments({ ...idle, failed: true })).toBe(false);
    // 失敗の表示を消しても、このログインではもう自動で読みに行かない
    expect(shouldAutoLoadDepartments({ ...idle, tried: true })).toBe(false);
  });

  it("読めている・読んでいる最中・「指定せず」を選んだときは読みに行かない", () => {
    expect(shouldAutoLoadDepartments({ ...idle, loaded: true })).toBe(false);
    expect(shouldAutoLoadDepartments({ ...idle, busy: true })).toBe(false);
    expect(shouldAutoLoadDepartments({ ...idle, skipped: true })).toBe(false);
  });

  it("★どの組み合わせでも、読みに行くのは「ログイン済み・未読・空き・失敗なし・指定せずでない・未実行」だけ", () => {
    let checked = 0;
    for (const loggedIn of [true, false])
      for (const loaded of [true, false])
        for (const busy of [true, false])
          for (const failed of [true, false])
            for (const skipped of [true, false])
              for (const tried of [true, false]) {
                checked += 1;
                const input = { loggedIn, loaded, busy, failed, skipped, tried };
                expect(shouldAutoLoadDepartments(input)).toBe(
                  loggedIn && !loaded && !busy && !failed && !skipped && !tried,
                );
              }
    expect(checked).toBe(64);
  });
});

describe("どの部門を選ぶか", () => {
  it("前に選んだ部門 → いま選ばれている部門 → 先頭 の順", () => {
    expect(pickDepartment([AFTER, QUALITY], "1900", "1800")).toEqual(QUALITY);
    expect(pickDepartment([AFTER, QUALITY], null, "1900")).toEqual(QUALITY);
    expect(pickDepartment([AFTER, QUALITY], "9999", null)).toEqual(AFTER);
    expect(pickDepartment([], "1800", "1800")).toBeNull();
  });
});

describe("部門を選べずに止まったときの戻り道", () => {
  const status = (over: Partial<StatusPayload>): StatusPayload => ({
    state: "error",
    done: 0,
    total: 0,
    current: null,
    message: "",
    error: "止まりました",
    error_file: null,
    processed: 0,
    remaining: 0,
    saved: [],
    ...over,
  });

  it("★選べる部門が届いていれば、画面の選択肢を直す指示を返す", () => {
    expect(
      departmentFixFromStatus(status({ error_code: "DEPT_NOT_AVAILABLE", error_departments: [AFTER, QUALITY] })),
    ).toEqual({ departments: [AFTER, QUALITY], deptCode: "1800" });
  });

  it("別の失敗・古いサーバー・空の一覧では何もしない", () => {
    expect(departmentFixFromStatus(status({ error_code: "BODY_PDF_FAILED" }))).toBeNull();
    expect(departmentFixFromStatus(status({}))).toBeNull();
    expect(departmentFixFromStatus(status({ error_code: "DEPT_NOT_AVAILABLE", error_departments: [] }))).toBeNull();
    expect(
      departmentFixFromStatus(status({ state: "done", error_code: "DEPT_NOT_AVAILABLE", error_departments: [AFTER] })),
    ).toBeNull();
  });
});
