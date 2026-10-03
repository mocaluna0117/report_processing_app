/**
 * 取得済みの伝票の「伝票画面の項目」を読み直して、記録に足す（ブラウザの中で動く）。
 *
 * 2026-10-03: 支出報告書の原価に「支払金額(税抜)」を使う。この項目は取得のときに読むようにしたが、
 * それより前に取得した顛末書の記録には無いので、伝票画面だけを開き直して埋める。
 *
 * ★PDF・添付は取らない。記録の file / at / 印 / 指紋には触らない。**記録に無い項目だけ**足す。
 * ★ログインの扱いは取得（job.ts）と同じ: 自動で入るのは最初の1回と、切れたときの1回だけ。
 * ★時間の上限で読めなかった分は、同じ実行の中で続けて頼む（進まなくなったら止める）。
 */
import type { RouteId } from "@/lib/rakuraku/protocol";
import type { RunLogLine, StatusPayload } from "@/lib/tenmatsu/client";
import { RUN_LOG_MAX_LINES } from "@/lib/tenmatsu/run-log";
import type { FolderStore } from "./fs";
import type { LocalKindConfig } from "./kind-config";
import { RUN_LOGIN_MAX, type RunAuth, type RunHandle, RunStop } from "./job";
import { type ProcessedData, hasValue, latestEntries, modifyRecords, readRecords } from "./records";
import { type RakurakuApi, RakurakuApiError, type RereadResult, type StreamHandlers } from "./server-api";

/** 読み直しで埋める項目（伝票画面のラベルは lib/rakuraku/kinds.ts） */
export const REREAD_KEYS = ["amount_ex_tax"] as const;

/** 1回の呼び出しで頼む件数（サーバーの上限 REREAD_MAX_ITEMS より小さく。時間内に読めない分は返ってくる） */
const BATCH = 40;
const BUSY_WAIT_MS = 20_000;
const BUSY_ATTEMPTS = 3;

/**
 * 読み直す伝票を選ぶ（書かない）。保存済みで、埋めたい項目のどれかが記録に無いもの。
 * 保留中の伝票は除く（確定するときに取得し直すわけではないが、記録の形が違うので触らない）。
 * 並びは記録の新しい順（支出報告書で使うのは最近の伝票なので、先に埋まるように）。
 */
export function planReread(records: ProcessedData, cfg: LocalKindConfig): string[] {
  if (!REREAD_KEYS.every((key) => cfg.metaKeys.includes(key))) return [];
  const latest = latestEntries(records);
  const out: string[] = [];
  for (const no of [...records.done].reverse()) {
    if (records.pending[no]) continue;
    const entry = latest.get(no);
    if (!entry) continue;
    if (REREAD_KEYS.some((key) => !hasValue(entry[key]))) out.push(no);
  }
  return out;
}

/**
 * 読んだ項目を記録に足す。**記録に無い項目だけ**、記録に残す項目（metaKeys）だけ。
 * 変えた伝票の数を返す（何も変えなければ書かない＝控えを無駄に上書きしない）。
 */
export async function mergeDetailFields(
  store: FolderStore,
  cfg: LocalKindConfig,
  byNo: ReadonlyMap<string, Record<string, string>>,
): Promise<number> {
  if (byNo.size === 0) return 0;
  return await modifyRecords(store, cfg, (data) => {
    const latest = latestEntries(data);
    let count = 0;
    for (const [no, fields] of byNo) {
      const entry = latest.get(no);
      if (!entry || data.pending[no]) continue;
      let changed = false;
      for (const key of cfg.metaKeys) {
        if (!hasValue(fields[key]) || hasValue(entry[key])) continue;
        entry[key] = fields[key];
        changed = true;
      }
      if (changed) count++;
    }
    return { changed: count > 0, result: count };
  });
}

export interface RereadDeps {
  store: FolderStore;
  cfg: LocalKindConfig;
  api: RakurakuApi;
  auth: RunAuth;
  deptCode: string | null;
  routePin?: RouteId | null;
  sleep?: (ms: number) => Promise<void>;
}

export function startReread(deps: RereadDeps): RunHandle {
  const { store, cfg, api, auth } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const lines: RunLogLine[] = [];
  let seq = 0;
  const listeners = new Set<(status: StatusPayload) => void>();
  let aborted = false;
  const state: Omit<StatusPayload, "log" | "log_seq" | "saved" | "pending" | "skipped"> = {
    kind: cfg.id,
    mode: "reread",
    state: "running",
    done: 0,
    total: 0,
    current: null,
    message: "読み直しを始めます",
    error: null,
    error_file: null,
    processed: 0,
    remaining: 0,
  };
  const snapshot = (since?: number): StatusPayload => ({
    ...state,
    saved: [],
    log_seq: seq,
    ...(since === undefined ? {} : { log: lines.filter((l) => l.seq > since) }),
  });
  const notify = () => {
    const status = snapshot();
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        /* 通知の失敗で本処理を止めない */
      }
    }
  };
  const print = (text: string) => {
    seq += 1;
    lines.push({ seq, text });
    if (lines.length > RUN_LOG_MAX_LINES) lines.splice(0, lines.length - RUN_LOG_MAX_LINES);
    notify();
  };
  const emit = (patch: Partial<typeof state>) => {
    Object.assign(state, patch);
    notify();
  };
  const handlers: StreamHandlers = {
    log: print,
    progress: (_stage, message) => emit({ message }),
    session: (token) => auth.setToken(token),
    route: (event) => print(`  一覧の経路: ${event.label}${event.how === "fallback" ? "（切り替え）" : ""}`),
  };

  const whenFree = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (e) {
        if (!(e instanceof RakurakuApiError) || e.code !== "BROWSER_BUSY" || attempt >= BUSY_ATTEMPTS) throw e;
        print(`  （ほかの人の取得と重なって混み合っているので、${BUSY_WAIT_MS / 1000}秒待ってやり直します）`);
        await sleep(BUSY_WAIT_MS);
      }
    }
  };

  let relogged = false;
  let logins = 0;
  const ensureLogin = async () => {
    if (auth.token()) return;
    if (logins >= RUN_LOGIN_MAX) throw new RunStop("楽楽精算のログインが続けて切れたので、読み直しを止めました。少し待ってから、もう一度押してください");
    logins += 1;
    print("楽楽精算にログインします（登録したIDとパスワードで自動）");
    emit({ message: "楽楽精算にログインしています" });
    auth.setToken(await whenFree(() => auth.login()));
    print("  ログインしました");
  };
  const withSession = async <T>(call: (token: string) => Promise<T>): Promise<T> => {
    await ensureLogin();
    try {
      return await whenFree(() => call(auth.token()!));
    } catch (e) {
      if (!(e instanceof RakurakuApiError) || !e.sessionLost) throw e;
      auth.setToken(null);
      if (relogged) throw e;
      relogged = true;
      print("  ! 楽楽精算のログインが切れたので、1回だけログインし直してやり直します");
      await ensureLogin();
      return await whenFree(() => call(auth.token()!));
    }
  };

  const failed: string[] = [];

  const run = async () => {
    const records = await readRecords(store, cfg);
    let queue = planReread(records, cfg);
    const total = queue.length;
    print(`読み直す${cfg.label}: ${total}件（支払金額(税抜)が記録に無いもの）`);
    if (total === 0) {
      emit({ state: "done", message: "読み直す伝票はありませんでした" });
      return;
    }
    emit({ total, message: `対象 ${total}件` });

    let written = 0;
    while (queue.length > 0) {
      if (aborted) {
        print(`! 中止しました（残り ${queue.length}件は次に押したときに読みます）`);
        emit({ remaining: queue.length });
        break;
      }
      const batch = queue.slice(0, BATCH);
      print("");
      print(`${batch.length}件を読みます（残り ${queue.length}件）`);
      // ★届いた分はその場でためておき、途中で失敗しても（ブラウザが落ちた・ログインが切れた）記録に足す
      const result: RereadResult = { fields: [], failed: [] };
      const save = async () => {
        const byNo = new Map(result.fields.map((f) => [f.denpyoNo, f.fields]));
        const added = await mergeDetailFields(store, cfg, byNo);
        written += added;
        state.processed = written;
        return byNo;
      };
      try {
        await withSession((token) =>
          api.reread(
            {
              sessionToken: token,
              kind: cfg.id,
              deptCode: deps.deptCode,
              denpyoNos: batch,
              ...(deps.routePin ? { route: deps.routePin } : {}),
            },
            handlers,
            undefined,
            result,
          ),
        );
      } catch (e) {
        const before = written;
        await save();
        if (written > before) print(`  （止まる前に読めた ${written - before}件は記録に足しました）`);
        throw e;
      }
      const byNo = await save();
      for (const f of result.failed) {
        failed.push(f.denpyoNo);
        print(`  ! 伝票№ ${f.denpyoNo}: ${f.reason}`);
      }
      const answered = new Set([...byNo.keys(), ...result.failed.map((f) => f.denpyoNo)]);
      const rest = batch.filter((no) => !answered.has(no));
      // ★1件も返事が無ければ進んでいない。同じ頼み方を繰り返さずに止める
      if (answered.size === 0) {
        print("! 時間内に1件も読めなかったので止めます（少し待ってから、もう一度押してください）");
        emit({ remaining: queue.length });
        break;
      }
      queue = [...rest, ...queue.slice(batch.length)];
      emit({ done: total - queue.length, processed: written, message: `${total - queue.length}/${total}件を読みました` });
    }

    const notFilled = failed.length;
    const message =
      `${written}件の記録に支払金額(税抜)を足しました` +
      (notFilled > 0 ? `（${notFilled}件は読めませんでした）` : "") +
      (state.remaining > 0 ? `（残り${state.remaining}件）` : "");
    print("");
    print(`完了: ${message}`);
    // ★skipped には入れない（取得の完了文言が「本体PDFを取れず見送り」と読んでしまう）。読めなかった件は message で伝える
    emit({ state: "done", message, processed: written, current: null });
  };

  const finished = (async (): Promise<StatusPayload> => {
    try {
      await run();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      print("");
      print(`! エラーで停止しました: ${message}`);
      print("! それまでに読めた分は記録に足してあります。もう一度押すと、残りから読みます。");
      emit({
        state: "error",
        error: message,
        message,
        ...(e instanceof RakurakuApiError ? { error_code: e.code } : {}),
      });
    }
    return snapshot();
  })();

  return {
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort: () => {
      aborted = true;
    },
    finished,
  };
}
