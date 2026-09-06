import { describe, expect, it } from "vitest";
import type { RunLogLine, StatusPayload } from "@/lib/tenmatsu/client";
import {
  appendRunLog,
  isRunLogLine,
  nextLogSince,
  RUN_LOG_MAX_LINES,
  runLogTone,
} from "@/lib/tenmatsu/run-log";

/** /status の応答 (log 関係だけ差し替えられるようにする) */
const status = (over: Partial<StatusPayload> = {}): StatusPayload => ({
  state: "running",
  done: 1,
  total: 2,
  current: "TE00009001",
  message: "1件目を処理しています",
  error: null,
  error_file: null,
  processed: 0,
  remaining: 0,
  saved: [],
  ...over,
});

const line = (seq: number, text = `line${seq}`): RunLogLine => ({ seq, text });

describe("コンソール出力の受け取り", () => {
  it("来た順に末尾へ足す", () => {
    const first = appendRunLog([], status({ log: [line(1), line(2)], log_seq: 2 }));
    const second = appendRunLog(first, status({ log: [line(3)], log_seq: 3 }));
    expect(second.map((l) => l.text)).toEqual(["line1", "line2", "line3"]);
  });

  it("★log が入っていない応答では同じ配列をそのまま返す (画面を描き直さない)", () => {
    const prev = [line(1)];
    // 古いサーバー・since 無しの呼び方・/run の応答
    expect(appendRunLog(prev, status())).toBe(prev);
    expect(appendRunLog(prev, status({ log_seq: 5 }))).toBe(prev);
    // 新しい行が0件のときも作り直さない
    expect(appendRunLog(prev, status({ log: [], log_seq: 1 }))).toBe(prev);
  });

  it("形の合わない行は捨てる", () => {
    const got = appendRunLog(
      [],
      status({
        log: [line(1), { seq: "2", text: "x" }, { seq: 3 }, { text: "y" }, null, line(4)] as never,
        log_seq: 4,
      }),
    );
    expect(got.map((l) => l.seq)).toEqual([1, 4]);
  });

  it("空行も1行として残す (伝票ごとの区切りになる)", () => {
    const got = appendRunLog([], status({ log: [line(1, ""), line(2, "[1/2] 伝票No. X")] }));
    expect(got.map((l) => l.text)).toEqual(["", "[1/2] 伝票No. X"]);
  });

  it("★上限を超えたら古い行から捨てる", () => {
    const many = Array.from({ length: RUN_LOG_MAX_LINES + 50 }, (_, i) => line(i + 1));
    const got = appendRunLog([], status({ log: many }));
    expect(got).toHaveLength(RUN_LOG_MAX_LINES);
    expect(got[0].seq).toBe(51);
    expect(got[got.length - 1].seq).toBe(RUN_LOG_MAX_LINES + 50);
  });

  it("isRunLogLine", () => {
    expect(isRunLogLine(line(1))).toBe(true);
    expect(isRunLogLine({ seq: 1, text: "" })).toBe(true);
    expect(isRunLogLine({ seq: Number.NaN, text: "x" })).toBe(false);
    expect(isRunLogLine({ seq: 1, text: 2 })).toBe(false);
    expect(isRunLogLine(null)).toBe(false);
  });
});

describe("次に取りに行く位置", () => {
  it("★最後の行の seq ではなく応答の log_seq を使う", () => {
    // 上限で古い行が落ちていると、返ってきた行の seq より log_seq のほうが進んでいる
    expect(nextLogSince(status({ log: [line(7)], log_seq: 120 }), 0)).toBe(120);
  });

  it("log_seq を返さない古いサーバーでは今の値のまま", () => {
    expect(nextLogSince(status(), 42)).toBe(42);
  });

  it("★新しい実行で番号が戻っても、その値をそのまま使う (次の1回で全行が来る)", () => {
    expect(nextLogSince(status({ log_seq: 3 }), 500)).toBe(3);
  });
});

describe("行の色分け", () => {
  it("字下げがあっても見分ける", () => {
    expect(runLogTone("  OK 保存: C:\\Users\\x\\顛末書No.1742.pdf")).toBe("ok");
    expect(runLogTone("! 対象 15件のうち、今回は先頭 10件だけ処理します")).toBe("warn");
    expect(runLogTone("  ! 動画・音声のため結合しませんでした: 現場動画.mp4")).toBe("warn");
    expect(runLogTone("[13/15] 伝票No. 00001742")).toBe("plain");
    expect(runLogTone("")).toBe("plain");
    expect(runLogTone("  本体PDFを取得")).toBe("plain");
  });

  it("「OK」で始まるだけの語は緑にしない", () => {
    expect(runLogTone("OKAYAMA")).toBe("plain");
  });
});
