/**
 * 取得の進行役（ブラウザの中で動く）。
 *
 * 移植元: tenmatsu.py `run_job` 3593-3810 と `process_one` 4791-4945（保存・保留の部分）
 *
 * 流れ: 記録を読む → （必要なら）ログイン → 一覧から対象を見つける → 伝票ごとに
 *       取得（Folio のサーバー）→ 部品を組む → 結合 → 保存（または保留）→ **置いた直後に記録**
 *
 * ★この画面を開いている間だけ動く（タブを閉じると止まる）。止め方は「いまの伝票が終わったら止める」。
 * ★ログインは自動でやり直さない。ただしログインが切れたときだけ、パスワードがメモリにあれば
 *   **この実行の中で1回だけ**ログインし直して同じ伝票をやり直す。
 * ★本体PDFが取れなかった伝票は記録せず見送る（次回やり直す）。続けて2件なら止める（ログイン切れの可能性）。
 */
import type { ReceivedFile, ScanTarget } from "@/lib/rakuraku/protocol";
import { scanSummary } from "@/lib/rakuraku/parse/list";
import type { RunLogLine, SavedItem, StatusPayload } from "@/lib/tenmatsu/client";
import { RUN_LOG_MAX_LINES } from "@/lib/tenmatsu/run-log";
import type { FolderStore } from "./fs";
import { type LocalKindConfig, MANIFEST_NAME, PENDING_MERGED_NAME, RECORDS_DIR } from "./kind-config";
import { type ManifestPart, recordPages } from "./manifest";
import { mergeParts } from "./merge";
import { decideOutputName, safeComponent, stemOf } from "./naming";
import {
  type MissingEntry,
  appendProcessed,
  doneAndPending,
  hasValue,
  localStamp,
  pendingDirPath,
  readRecords,
  recordsPath,
  registerPending,
} from "./records";
import { type RakurakuApi, RakurakuApiError, type StreamHandlers } from "./server-api";

/** 楽楽精算のログインに使うもの。★パスワードはメモリにだけ置く（呼ぶ側が持つ） */
export interface RunAuth {
  userId: string;
  password(): string | null;
  token(): string | null;
  setToken(token: string | null): void;
}

export interface RunDeps {
  store: FolderStore;
  cfg: LocalKindConfig;
  api: RakurakuApi;
  auth: RunAuth;
  /** 部門の値。部門の切り替えが無いアカウントは null */
  deptCode: string | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** 伝票1件ごとにあける間隔。移植元 1.5 秒 */
  requestIntervalMs?: number;
}

export interface RunInput {
  /** 1回に取る件数 */
  limit: number;
}

export interface RunHandle {
  /** いまの状態。since を渡すと、その番号より後の行も入る（画面の既存の作りに合わせる） */
  snapshot(since?: number): StatusPayload;
  /** 状態が変わるたびに呼ばれる。戻り値で購読をやめる */
  subscribe(listener: (status: StatusPayload) => void): () => void;
  /** いまの伝票が終わったら止める */
  abort(): void;
  readonly finished: Promise<StatusPayload>;
}

/** 利用者に理由を伝えて止める失敗（例外の名前を付けずに出す） */
export class RunStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunStop";
  }
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

/** 移植元の stamp() と同じ形（20260913_101500） */
export function fileStamp(now: Date): string {
  return `${now.getFullYear()}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}_${pad(now.getHours(), 2)}${pad(now.getMinutes(), 2)}${pad(now.getSeconds(), 2)}`;
}

export function startRun(deps: RunDeps, input: RunInput): RunHandle {
  const { store, cfg, api, auth } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = deps.requestIntervalMs ?? 1_500;

  const lines: RunLogLine[] = [];
  let seq = 0;
  const listeners = new Set<(status: StatusPayload) => void>();
  let aborted = false;
  const saved: SavedItem[] = [];
  const pending: { denpyo_no: string; missing: string[]; awaiting: boolean }[] = [];
  const skipped: string[] = [];
  const state: Omit<StatusPayload, "log" | "log_seq" | "saved" | "pending" | "skipped"> = {
    kind: cfg.id,
    state: "running",
    done: 0,
    total: 0,
    current: null,
    message: "取得を始めます",
    error: null,
    error_file: null,
    processed: 0,
    remaining: 0,
  };

  const snapshot = (since?: number): StatusPayload => ({
    ...state,
    saved: [...saved],
    pending: [...pending],
    skipped: [...skipped],
    log_seq: seq,
    ...(since === undefined ? {} : { log: lines.filter((l) => l.seq > since) }),
  });

  const notify = () => {
    const status = snapshot();
    for (const listener of listeners) {
      try {
        listener(status);
      } catch {
        /* 通知の失敗で本処理を止めない（移植元と同じ） */
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
  };

  // --- ログイン（★自動でやり直すのは、切れたときの1回だけ）
  let relogged = false;
  const ensureLogin = async () => {
    if (auth.token()) return;
    const password = auth.password();
    if (!password) throw new RunStop("楽楽精算のパスワードを入力してから取得してください");
    print("楽楽精算にログインします");
    emit({ message: "楽楽精算にログインしています" });
    const { sessionToken } = await api.login(auth.userId, password);
    auth.setToken(sessionToken);
    print("  ログインしました");
  };

  const withSession = async <T>(call: (token: string) => Promise<T>): Promise<T> => {
    await ensureLogin();
    try {
      return await call(auth.token()!);
    } catch (e) {
      if (!(e instanceof RakurakuApiError) || !e.sessionLost) throw e;
      auth.setToken(null);
      if (relogged || !auth.password()) throw e;
      relogged = true;
      print("  ! 楽楽精算のログインが切れたので、1回だけログインし直してやり直します");
      await ensureLogin();
      return await call(auth.token()!);
    }
  };

  let currentNo = "(未着手)";

  /** 伝票1件を取得して、保存か保留にする */
  const processOne = async (target: ScanTarget): Promise<"saved" | "pending"> => {
    const { denpyoNo } = target;
    const result = await withSession((token) =>
      api.fetch({ sessionToken: token, kind: cfg.id, denpyoNo, href: target.href, deptCode: deps.deptCode }, handlers),
    );

    // 時間の上限で取れなかった添付を、1つずつ取り直す
    const attachments = [...result.attachments];
    const failures = [];
    for (const failure of result.failures) {
      if (failure.code !== "TIME_BUDGET_EXCEEDED") {
        failures.push(failure);
        continue;
      }
      try {
        print(`    ${failure.index}件目の添付を取り直します`);
        const file = await withSession((token) =>
          api.attachment(
            { sessionToken: token, kind: cfg.id, denpyoNo, href: target.href, deptCode: deps.deptCode, index: failure.index, expectedName: failure.name },
            handlers,
          ),
        );
        attachments.push(file);
      } catch (e) {
        if (e instanceof RakurakuApiError && e.sessionLost) throw e;
        failures.push({ ...failure, code: "ATTACHMENT_FAILED" as const, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    // --- 部品を組む（連番が結合の順を決める）
    const body = result.body as ReceivedFile;
    const bodyName = `000_本体${body.ext}`;
    const parts: { name: string; bytes: Uint8Array }[] = [{ name: bodyName, bytes: body.bytes }];
    const slots: ManifestPart[] = [];
    for (const [i, name] of (result.attachmentNames ?? []).entries()) {
      const index = i + 1;
      const file = attachments.find((a) => a.index === index);
      if (file) {
        const partName = `${pad(index, 3)}_${safeComponent(stemOf(name))}${file.ext}`;
        parts.push({ name: partName, bytes: file.bytes });
        slots.push({ index, name, file: partName, status: "ok" });
      } else {
        const failure = failures.find((f) => f.index === index);
        slots.push({ index, name, file: null, status: "failed", reason: failure?.reason ?? "添付を取得できませんでした" });
      }
    }

    // --- 結合（作業はメモリの中。正式な場所に置くのは最後）
    const merged = await mergeParts(parts, { collectFailures: true, strictFirst: true });
    print(`  結合: ${parts.length - merged.skipped.length - merged.failed.length}ファイル → ${merged.totalPages}ページ`);
    const fields: Record<string, unknown> = {};
    if (merged.skipped.length > 0) {
      // 作業用の連番（001_）を外して、画面に出ていた名前に近い形で残す
      const names = merged.skipped.map((n) => n.replace(/^\d{3}_/, ""));
      fields.skipped_attachments = names;
      print(`  ! 動画・音声のため結合しませんでした: ${names.join(", ")}`);
    }
    const byFile = new Map(slots.filter((s) => s.file).map((s) => [s.file as string, s]));
    for (const name of merged.skipped) {
      const slot = byFile.get(name);
      if (slot) slot.status = "skipped";
    }
    for (const bad of merged.failed) {
      const slot = byFile.get(bad.name);
      if (slot) {
        slot.status = "failed";
        slot.reason = bad.reason;
      }
    }

    // 伝票画面で読めた値は一覧の値より優先する。★読めなかった項目で一覧の値を消さない
    const meta: Record<string, unknown> = { ...target.meta };
    for (const [key, value] of Object.entries({ ...result.fields, ...fields })) if (hasValue(value)) meta[key] = value;

    const missing: MissingEntry[] = slots
      .filter((s) => s.status === "failed")
      .map((s) => ({ index: Number(s.index), name: s.name, reason: s.reason ?? "" }));

    if (missing.length > 0) {
      // --- 保留にする。本体と結合できた添付だけの PDF と、全部の部品を _保留/ へ置いてから記録する
      const dirName = safeComponent(denpyoNo);
      const dir = pendingDirPath(dirName);
      await store.remove(dir, { recursive: true });
      for (const part of parts) await store.writeBytes([...dir, part.name], part.bytes);
      await store.writeBytes([...dir, PENDING_MERGED_NAME], merged.bytes);
      const heldParts: ManifestPart[] = [{ index: 0, name: "本体", file: bodyName, status: "ok" }, ...slots];
      recordPages(heldParts, parts.map((p) => p.name), merged.pageCounts);
      await store.writeBytes(
        [...dir, MANIFEST_NAME],
        JSON.stringify({ denpyo_no: denpyoNo, kind: cfg.id, at: localStamp(now()), parts: heldParts, merged_pages: merged.totalPages }, null, 2),
      );
      // ★ファイルを置いてから記録する（逆だと「記録はあるがファイルが無い」を作れてしまう）
      await registerPending(store, cfg, denpyoNo, dirName, missing, meta, now());
      print(`  ! 添付を結合できなかったので保留にしました: ${missing.map((m) => `${m.name}（${m.reason}）`).join("、")}`);
      pending.push({ denpyo_no: denpyoNo, missing: missing.map((m) => m.name), awaiting: false });
      return "pending";
    }

    const name = await decideOutputName(store, [], denpyoNo, cfg.filePrefix);
    await store.writeBytes([name], merged.bytes);
    // ★PDF を置いたら、その直後に記録する。この間に何も挟まない
    await appendProcessed(store, cfg, denpyoNo, name, meta, now());
    print(`  OK 保存: ${name}`);
    saved.push({ denpyo_no: denpyoNo, file: name });
    return "saved";
  };

  const run = async (): Promise<void> => {
    if (cfg.composed) throw new RunStop(`${cfg.label}の取得は、この画面ではまだ使えません`);
    const records = await readRecords(store, cfg);
    const held = Object.keys(records.pending).length;
    print(`処理済み: ${records.done.length}件（${recordsPath(cfg).join("/")}）${held > 0 ? ` / 保留 ${held}件` : ""}`);
    emit({ message: `処理済み ${records.done.length}件` });

    print(`${cfg.label}一覧へ移動します`);
    emit({ message: `${cfg.label}一覧を読んでいます` });
    // 保留中の伝票は取り直さない（確定するまで待つ）
    const scan = await withSession((token) =>
      api.scan({ sessionToken: token, kind: cfg.id, deptCode: deps.deptCode, done: doneAndPending(records), limit: input.limit }, handlers),
    );
    let targets = scan.items;
    const found = targets.length;
    let remaining = 0;
    if (found > input.limit) {
      remaining = found - input.limit;
      print(`! 対象 ${found}件のうち、今回は先頭 ${input.limit}件だけ処理します（1回に取る件数）。残りは次回実行してください`);
      targets = targets.slice(0, input.limit);
    }

    if (targets.length === 0) {
      // ★「対象が無かった」と「最後まで読めなかった」を混ぜない
      const message = scanSummary(scan, cfg.label);
      print(message);
      emit({ state: "done", message, done: 0, total: 0, remaining: 0 });
      return;
    }
    if (scan.stoppedEarly) print(scanSummary(scan, cfg.label)); // 取り残しを黙らない

    const total = targets.length;
    print(`対象 ${total}件: ${targets.map((t) => t.denpyoNo).join(", ")}`);
    emit({ message: `対象 ${total}件`, done: 0, total, remaining });

    let bodyMisses = 0;
    for (const [i, target] of targets.entries()) {
      const idx = i + 1;
      if (aborted) {
        const rest = total - i;
        print(`! 中止しました（残り ${rest}件は次回取得します）`);
        emit({ remaining: remaining + rest });
        break;
      }
      currentNo = target.denpyoNo;
      print("");
      print(`[${idx}/${total}] 伝票No. ${target.denpyoNo}`);
      emit({ message: `伝票No. ${target.denpyoNo} を処理しています`, done: i, total, current: target.denpyoNo });
      try {
        const outcome = await processOne(target);
        bodyMisses = 0;
        if (outcome === "saved") {
          state.processed += 1;
          emit({ message: `${saved.at(-1)!.file} を保存しました`, done: idx });
        } else {
          emit({ message: `伝票No. ${target.denpyoNo} は添付を結合できず保留にしました`, done: idx });
        }
      } catch (e) {
        if (!(e instanceof RakurakuApiError) || e.code !== "BODY_PDF_FAILED") throw e;
        // 本体PDFだけは保留にできない（PDFが1枚も無い）。記録に残さないので、次回の取得でやり直される
        bodyMisses += 1;
        skipped.push(target.denpyoNo);
        print(`  ! ${e.message}`);
        print("  ! この伝票は見送ります（次回の取得でやり直します）");
        emit({ message: `伝票No. ${target.denpyoNo} は本体PDFを取れず見送りました`, done: idx });
        // ★続けて失敗するならログイン切れ。1件ずつ延々と待つより止める
        if (bodyMisses >= 2) throw new RunStop("本体PDFの取得が続けて失敗しました（楽楽精算のログインが切れた可能性があります）");
      }
      if (idx < total) await sleep(intervalMs);
    }

    const held2 = pending.length;
    const notes = (held2 > 0 ? `（${held2}件は添付を結合できず保留）` : "") + (skipped.length > 0 ? `（${skipped.length}件は本体PDFを取れず見送り）` : "");
    print("");
    print(`完了: ${state.processed}件を保存しました${notes}`);
    emit({ state: "done", message: `${state.processed}件を保存しました${notes}`, current: null });
  };

  const finished = (async (): Promise<StatusPayload> => {
    try {
      await run();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const tag = fileStamp(now());
      const errorPath = [RECORDS_DIR, `エラー_${tag}.txt`];
      print("");
      print(`! エラーで停止しました: ${message}`);
      print(`! 完了した${state.processed}件は記録済みです。未完了の件は次回の取得でやり直されます。`);
      let errorFile: string | null = errorPath.join("/");
      try {
        await store.writeBytes(
          errorPath,
          [
            `処理中だった伝票No.: ${currentNo}`,
            `完了済み: ${state.processed}件`,
            `見送り: ${skipped.length}件 ${skipped.join(", ")}`,
            `保留: ${pending.length}件`,
            `エラー: ${e instanceof RakurakuApiError ? `${e.code} ` : ""}${message}`,
            "",
            ...lines.map((l) => l.text),
            "",
          ].join("\n"),
        );
      } catch {
        errorFile = null; // 書けなくても、画面には理由を出す
      }
      emit({ state: "error", error: message, error_file: errorFile, message, current: currentNo === "(未着手)" ? null : currentNo });
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
