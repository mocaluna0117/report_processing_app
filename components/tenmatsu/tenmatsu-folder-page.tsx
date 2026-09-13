"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { StorageBanner } from "@/components/storage-banner";
import { TenmatsuImportRecords } from "@/components/tenmatsu/tenmatsu-import-records";
import { TenmatsuList } from "@/components/tenmatsu/tenmatsu-list";
import { TenmatsuPendingDialog } from "@/components/tenmatsu/tenmatsu-pending-dialog";
import { TenmatsuPreviewDialog } from "@/components/tenmatsu/tenmatsu-preview-dialog";
import { TenmatsuRunLog } from "@/components/tenmatsu/tenmatsu-run-log";
import { TenmatsuStaffSync } from "@/components/tenmatsu/tenmatsu-staff-sync";
import type { DepartmentOption } from "@/lib/rakuraku/protocol";
import { isStorageAvailable } from "@/lib/storage";
import {
  type FlagKey,
  type ListItem,
  type PendingFile,
  type RunLogLine,
  type StatusPayload,
  TenmatsuError,
  describeCompletion,
  isFinished,
  isPending,
} from "@/lib/tenmatsu/client";
import { DOC_KIND_BY_ID, type DocKindId, clearListConfirmText, clearedNoticeText, flagErrorText } from "@/lib/tenmatsu/kinds";
import type { ListFilter } from "@/lib/tenmatsu/list-view";
import { activeRunKind, createLocalFolderClient, hasActiveRun, type LocalFolderClient } from "@/lib/tenmatsu/local/client";
import { FolderStore } from "@/lib/tenmatsu/local/fs";
import {
  type BrowserDirHandle,
  FOLDER_UNSUPPORTED_TEXT,
  ensureFolderPermission,
  isFolderAccessSupported,
  pickFolder,
  queryFolderPermission,
} from "@/lib/tenmatsu/local/folder-handle";
import { RUN_LIMITS } from "@/lib/tenmatsu/local/kind-config";
import { createRakurakuApi, RakurakuApiError } from "@/lib/tenmatsu/local/server-api";
import {
  type FolderConnection,
  forgetLogin,
  getFolderSession,
  getPassword,
  getSessionToken,
  keepFolderSession,
  setLogin,
  subscribeLogin,
} from "@/lib/tenmatsu/local/session";
import { idbStatsCache } from "@/lib/tenmatsu/local/stats-cache";
import { FOLDER_ATTACHMENTS, FOLDER_OFFICE_HINT } from "@/lib/tenmatsu/pending";
import { appendRunLog, nextLogSince } from "@/lib/tenmatsu/run-log";
import {
  clearFolderHandle,
  clearFolderList,
  clearUserId,
  hasFolderData,
  loadDept,
  loadFolderHandle,
  loadFolderList,
  loadMaxPerRun,
  loadUserId,
  saveDept,
  saveFolderHandle,
  saveFolderList,
  saveMaxPerRun,
  saveUserId,
} from "@/lib/tenmatsu/store";
import { usePersistence } from "@/lib/use-persistence";

const SECTION_CLASS = "rounded-lg border border-slate-200 bg-white p-4";
const SUBTITLE_CLASS = "ml-2 text-xs font-normal text-slate-500";
const PRIMARY_BUTTON_CLASS =
  "rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON_CLASS =
  "rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const INPUT_CLASS =
  "rounded border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50";
const ERROR_CLASS = "mt-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800";
const WARN_CLASS = "mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Folio のサーバー（/api/rakuraku/*）。ページの中で1つ */
const api = createRakurakuApi();

/**
 * 新しい方式の画面。楽楽精算からの取得は Folio のサーバーが行い、PDF はこのブラウザで結合して
 * 利用者が選んだ PC のフォルダーへ書く（Folio のサーバーには残さない）。
 *
 * ★楽楽精算のパスワードは保存しない。ログインに使ったあとはメモリにだけ置く（再読み込みで消える）。
 * ★フォルダーを使う許可を尋ねるのは、ボタンを押したときだけ（読み込み直後に尋ねるとブラウザが断る）。
 * ★取得はこの画面を離れても続く。ブラウザのタブを閉じると止まる。
 */
export function TenmatsuFolderPage({ kind: kindId, header }: { kind: DocKindId; header?: ReactNode }) {
  const kind = DOC_KIND_BY_ID[kindId];
  const kept = getFolderSession(kind.id);

  const [supported, setSupported] = useState(true);
  const [handle, setHandle] = useState<BrowserDirHandle | null>(kept.handle);
  const [client, setClient] = useState<LocalFolderClient | null>(kept.client);
  const [connection, setConnection] = useState<FolderConnection>(kept.connection);
  const [connectionError, setConnectionError] = useState<string | null>(kept.connectionError);

  const [items, setItems] = useState<ListItem[]>(kept.items);
  const [listFresh, setListFresh] = useState(kept.listFresh);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listNotice, setListNotice] = useState<string | null>(null);
  const clearedRef = useRef(kept.cleared);

  const [status, setStatus] = useState<StatusPayload | null>(kept.status);
  const [runObserved, setRunObserved] = useState(kept.runObserved);
  const [logLines, setLogLines] = useState<RunLogLine[]>(kept.logLines);
  const logSinceRef = useRef(kept.logLines.at(-1)?.seq ?? 0);
  const [runError, setRunError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  /** 取得を始めるたびに増やす（購読を張り直すきっかけ） */
  const [runKey, setRunKey] = useState(0);

  const savingFlagsRef = useRef<ReadonlySet<string>>(new Set());
  const [savingFlags, setSavingFlags] = useState<ReadonlySet<string>>(new Set());
  const [flagError, setFlagError] = useState<string | null>(null);
  const [recentNos, setRecentNos] = useState<ReadonlySet<string>>(kept.recentNos);
  const [showCompleted, setShowCompleted] = useState(kept.showCompleted);
  const [listFilter, setListFilter] = useState<ListFilter>(kept.listFilter);
  const [maxInput, setMaxInput] = useState(kept.maxInput);

  const [userId, setUserId] = useState("");
  /** ログインIDをこのブラウザに保存してあるか（入力しただけでは消去の導線を出さない） */
  const [userIdSaved, setUserIdSaved] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [loggedIn, setLoggedIn] = useState(getSessionToken() !== null);
  const [hasPassword, setHasPassword] = useState(getPassword() !== null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [departments, setDepartments] = useState<DepartmentOption[] | null>(kept.departments);
  const [deptCode, setDeptCode] = useState<string | null>(kept.deptCode);
  const deptCodeRef = useRef(deptCode);
  deptCodeRef.current = deptCode;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  const [previewNo, setPreviewNo] = useState<string | null>(null);
  const [pendingNo, setPendingNo] = useState<string | null>(null);
  const [recomposeNo, setRecomposeNo] = useState<string | null>(null);

  // サーバーで描くときは window が無いので、ブラウザに来てから判定する
  useEffect(() => {
    setSupported(isFolderAccessSupported());
  }, []);

  // ほかの種類のタブでログインした・忘れたときも、この画面の表示を揃える
  useEffect(
    () =>
      subscribeLogin(() => {
        setLoggedIn(getSessionToken() !== null);
        setHasPassword(getPassword() !== null);
        if (getSessionToken() === null) setDepartments((prev) => (prev === null ? prev : null));
      }),
    [],
  );

  const storage = usePersistence({
    restore: async () => {
      if (kept.hydrated) {
        const saved = await loadUserId().catch(() => null);
        setUserId(saved ?? "");
        setUserIdSaved(saved !== null);
        return { partialErrors: [] };
      }
      const partialErrors: string[] = [];
      try {
        setHandle(await loadFolderHandle<BrowserDirHandle>(kind.id));
      } catch (e) {
        partialErrors.push(`保存先フォルダー: ${errorText(e)}`);
      }
      try {
        setItems(await loadFolderList(kind.id));
      } catch (e) {
        partialErrors.push(`取得済み一覧: ${errorText(e)}`);
      }
      try {
        const stored = await loadMaxPerRun(kind.id);
        const value = stored !== null && stored >= RUN_LIMITS.min && stored <= RUN_LIMITS.max ? stored : RUN_LIMITS.value;
        setMaxInput(String(value));
      } catch (e) {
        partialErrors.push(`取得件数: ${errorText(e)}`);
      }
      try {
        const saved = await loadUserId();
        setUserId(saved ?? "");
        setUserIdSaved(saved !== null);
      } catch (e) {
        partialErrors.push(`ログインID: ${errorText(e)}`);
      }
      return { partialErrors };
    },
    hasSaved: () => hasFolderData(kind.id),
  });

  const markSaving = (no: string, on: boolean) => {
    const next = new Set(savingFlagsRef.current);
    if (on) next.add(no);
    else next.delete(no);
    savingFlagsRef.current = next;
    setSavingFlags(next);
  };

  const refreshList = async (target: LocalFolderClient | null = client) => {
    if (!target || savingFlagsRef.current.size > 0) return;
    clearedRef.current = false;
    setListLoading(true);
    setListError(null);
    setFlagError(null);
    try {
      const fresh = await target.list();
      setItems(fresh);
      setListFresh(true);
      setRecentNos(new Set());
      storage.persist(() => saveFolderList(kind.id, fresh));
    } catch (e) {
      setListError(`一覧を読み込めませんでした (${errorText(e)})`);
      if (e instanceof TenmatsuError && (e.kind === "permission" || e.kind === "folderMissing")) {
        setConnection("error");
        setConnectionError(e.message);
      }
    } finally {
      setListLoading(false);
    }
  };
  const refreshListRef = useRef(refreshList);
  refreshListRef.current = refreshList;

  const makeClient = useCallback(
    (dir: BrowserDirHandle) =>
      createLocalFolderClient({
        kind: kind.id,
        store: new FolderStore(dir),
        api,
        auth: {
          get userId() {
            return userIdRef.current.trim();
          },
          password: getPassword,
          token: getSessionToken,
          setToken: (token) => setLogin({ sessionToken: token }),
        },
        deptCode: () => deptCodeRef.current,
        statsCache: idbStatsCache(kind.id),
      }),
    [kind.id],
  );

  /** フォルダーにつなぐ。askPermission は「ボタンを押した処理の中」でだけ true にする */
  const connect = async (dir: BrowserDirHandle, askPermission: boolean) => {
    setConnection("checking");
    setConnectionError(null);
    try {
      if (askPermission) await ensureFolderPermission(dir);
      const next = makeClient(dir);
      await next.health();
      setClient(next);
      setConnection("ok");
      setListNotice(null);
      // この画面を離れている間に始まった（続いている）取得の進捗を追い直す
      if (hasActiveRun(kind.id)) {
        setRunObserved(true);
        setRunKey((k) => k + 1);
      }
      await refreshListRef.current(next);
    } catch (e) {
      setConnection("error");
      setConnectionError(errorText(e));
    }
  };

  // 前回選んだフォルダーの許可がまだ生きていれば（Chrome の「今後も許可」など）、尋ねずにつなぐ
  useEffect(() => {
    if (!storage.restored || !handle || client || connection !== "idle") return;
    let alive = true;
    void queryFolderPermission(handle).then((state) => {
      if (alive && state === "granted") void connect(handle, false);
    });
    return () => {
      alive = false;
    };
    // connect は毎レンダー作り直されるので依存に入れない（つなぐのは条件がそろった1回だけ）
  }, [storage.restored, handle, client, connection]);

  const chooseFolder = async () => {
    setConnectionError(null);
    try {
      const picked = await pickFolder(kind.id);
      if (!picked) return;
      setHandle(picked);
      setClient(null);
      setItems([]);
      setListFresh(false);
      storage.persist(() => saveFolderHandle(kind.id, picked));
      await connect(picked, true);
    } catch (e) {
      setConnection("error");
      setConnectionError(errorText(e));
    }
  };

  // --- 楽楽精算のログインと部門 -------------------------------------------------

  const loadDepartments = async () => {
    const token = getSessionToken();
    if (!token) return;
    setLoginError(null);
    try {
      const res = await api.departments(token);
      setLogin({ sessionToken: res.sessionToken });
      setDepartments(res.departments);
      const saved = await loadDept(kind.id).catch(() => null);
      const pick =
        res.departments.find((d) => d.code === saved?.code) ??
        res.departments.find((d) => d.code === res.current?.code) ??
        res.departments[0] ??
        null;
      setDeptCode(pick?.code ?? null);
    } catch (e) {
      if (e instanceof RakurakuApiError && e.code === "DEPT_SELECT_MISSING") {
        // 部門の切り替えが無いアカウント。部門を指定せずに取得する
        setDepartments([]);
        setDeptCode(null);
        return;
      }
      if (e instanceof RakurakuApiError && e.sessionLost) setLogin({ sessionToken: null });
      setLoginError(`部門を読み込めませんでした (${errorText(e)})`);
    }
  };

  const login = async () => {
    const id = userId.trim();
    const pass = passwordInput;
    if (!id || !pass) {
      setLoginError("楽楽精算のログインIDとパスワードを入れてください");
      return;
    }
    setLoginBusy(true);
    setLoginError(null);
    try {
      // ★ログインは1回だけ。失敗しても自動でやり直さない（楽楽精算はアカウントをロックする）
      const { sessionToken } = await api.login(id, pass);
      setLogin({ password: pass, sessionToken });
      setPasswordInput("");
      storage.persist(async () => {
        await saveUserId(id);
        setUserIdSaved(true);
      });
      await loadDepartments();
    } catch (e) {
      setLoginError(errorText(e));
    } finally {
      setLoginBusy(false);
    }
  };

  const chooseDept = (code: string) => {
    const found = departments?.find((d) => d.code === code);
    if (!found) return;
    setDeptCode(code);
    storage.persist(() => saveDept(kind.id, found));
  };

  // --- 取得 --------------------------------------------------------------------

  const running = starting || status?.state === "running";
  const otherRunKind = activeRunKind();
  const otherRunning = otherRunKind !== null && otherRunKind !== kind.id;

  // 取得の進み具合を受け取る（ポーリングではなく、状態が変わるたびに知らせてもらう）
  useEffect(() => {
    if (!client || runKey === 0) return;
    let alive = true;
    let pulling = false;
    let again = false;
    const pull = async () => {
      if (pulling) {
        again = true;
        return;
      }
      pulling = true;
      try {
        do {
          again = false;
          const s = await client.status(logSinceRef.current);
          if (!alive) return;
          logSinceRef.current = nextLogSince(s, logSinceRef.current);
          setLogLines((prev) => appendRunLog(prev, s));
          setStatus(s);
          if (isFinished(s.state)) {
            setStopping(false);
            void refreshListRef.current(client);
            return;
          }
        } while (again && alive);
      } finally {
        pulling = false;
      }
    };
    const stop = client.subscribe(() => void pull());
    void pull();
    return () => {
      alive = false;
      stop();
    };
  }, [client, runKey]);

  // 取得中にブラウザのタブを閉じようとしたら確かめる（閉じると取得が止まる）
  useEffect(() => {
    if (status?.state !== "running") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [status?.state]);

  const startRun = async () => {
    if (!client) return;
    setRunError(null);
    setListNotice(null);
    const draft = maxInput.trim();
    const count = Number(draft);
    if (!/^\d+$/.test(draft) || count < RUN_LIMITS.min || count > RUN_LIMITS.max) {
      setRunError(`1回に取る件数は ${RUN_LIMITS.min}〜${RUN_LIMITS.max} の半角の数字で入れてください`);
      return;
    }
    setLogLines([]);
    logSinceRef.current = 0;
    setStarting(true);
    try {
      const result = await client.run({ maxPerRun: count });
      if (!result.started) {
        setRunError("別の書類の取得が動いています。終わってから始めてください");
        return;
      }
      setStatus(result.status);
      setRunObserved(true);
      setRunKey((k) => k + 1);
      storage.persist(() => saveMaxPerRun(kind.id, count));
    } catch (e) {
      setRunError(`${kind.label}の取得を始められませんでした (${errorText(e)})`);
    } finally {
      setStarting(false);
    }
  };

  const stopRun = () => {
    client?.abort();
    setStopping(true);
  };

  // --- 一覧の操作 ---------------------------------------------------------------

  const toggleFlag = async (no: string, flag: FlagKey, next: boolean) => {
    if (!client) return;
    setFlagError(null);
    markSaving(no, true);
    try {
      const updated = await client.setFlags(no, { [flag]: next });
      if (updated) {
        setItems((prev) => prev.map((i) => (i.denpyo_no === no ? updated : i)));
        setRecentNos((prev) => new Set(prev).add(no));
      }
    } catch (e) {
      const definite = e instanceof TenmatsuError && e.kind !== "unknown";
      setFlagError(flagErrorText(kind, no, definite, errorText(e)));
    } finally {
      markSaving(no, false);
    }
  };

  const completePending = async (no: string, files: PendingFile[], slots: number[], acceptMissing: boolean) => {
    if (!client) return;
    const updated = await client.completePending(no, { files, slots, acceptMissing });
    if (updated) setItems((prev) => prev.map((i) => (i.denpyo_no === no ? updated : i)));
    else await refreshListRef.current();
    setRecentNos((prev) => new Set(prev).add(no));
  };

  const recomposePending = async (no: string, files: PendingFile[], slots: number[]) => {
    if (!client) return;
    const updated = await client.recomposePending(no, files, slots);
    if (updated) setItems((prev) => prev.map((i) => (i.denpyo_no === no ? updated : i)));
    else await refreshListRef.current();
    setRecentNos((prev) => new Set(prev).add(no));
  };

  const retryPending = async (no: string) => {
    if (!client) return;
    try {
      await client.retryPending(no);
    } catch (e) {
      if (!(e instanceof TenmatsuError && e.kind === "notFound")) throw e;
    }
    setItems((prev) => prev.filter((i) => i.denpyo_no !== no));
  };

  const loadPdf = useCallback(
    (no: string) => {
      if (!client) return Promise.reject(new Error("保存先フォルダーにつないでください"));
      return client.filePdf(no);
    },
    [client],
  );

  // --- 保存データの消去 ---------------------------------------------------------

  const clearList = async () => {
    if (!confirm(clearListConfirmText(kind))) return;
    if (isStorageAvailable()) {
      try {
        await clearFolderList(kind.id);
      } catch (e) {
        storage.setStorageError(`一覧を消去できませんでした (${errorText(e)})`);
      }
    }
    clearedRef.current = true;
    setItems([]);
    setListFresh(false);
    setRecentNos(new Set());
    setListNotice(clearedNoticeText(kind));
    storage.refreshHasSaved();
    storage.refreshUsage();
  };

  const forgetFolder = async () => {
    if (!confirm("保存先フォルダーの登録を消します（フォルダーの中のPDFと記録は消えません）。よろしいですか？")) return;
    try {
      await clearFolderHandle(kind.id);
    } catch (e) {
      storage.setStorageError(`保存先フォルダーの登録を消せませんでした (${errorText(e)})`);
    }
    setHandle(null);
    setClient(null);
    setConnection("idle");
    setConnectionError(null);
    storage.refreshHasSaved();
  };

  const forgetUserId = async () => {
    if (!confirm("楽楽精算のログインIDの登録を消し、ログインも解除します。よろしいですか？")) return;
    try {
      await clearUserId();
    } catch (e) {
      storage.setStorageError(`ログインIDの登録を消せませんでした (${errorText(e)})`);
    }
    setUserId("");
    setUserIdSaved(false);
    forgetLogin();
    setDepartments(null);
    setDeptCode(null);
    storage.refreshHasSaved();
  };

  // 画面の状態を控える（タブを移動して戻ってきたときに続きから使えるように）
  useEffect(() => {
    keepFolderSession(kind.id, {
      handle,
      client,
      connection,
      connectionError,
      items,
      listFresh,
      cleared: clearedRef.current,
      recentNos,
      showCompleted,
      listFilter,
      status,
      runObserved,
      logLines,
      maxInput,
      departments,
      deptCode,
    });
  });

  // 戻ってきたとき、取得が続いていれば進捗を追い直す
  useEffect(() => {
    if (client && hasActiveRun(kind.id)) setRunKey((k) => k + 1);
  }, []);

  // --- 表示 --------------------------------------------------------------------

  const connected = connection === "ok" && client !== null;
  const flagDisabledReason = !storage.restored
    ? "前回の内容を読み込んでいます"
    : !connected
      ? "保存先フォルダーにつなぐと変更できます"
      : !listFresh
        ? "前回このブラウザで見た内容です。「一覧を再読み込み」でフォルダーの記録を読み込むと変更できます"
        : listLoading
          ? "一覧を読み込んでいます"
          : null;
  const resolveDisabledReason =
    flagDisabledReason ?? (running || otherRunning ? "取得中は添付を結合できません。取得が終わってから操作してください" : null);
  const completion = status && !running && runObserved ? describeCompletion(status, kind.label) : null;
  const deptLabel = departments?.find((d) => d.code === deptCode)?.label ?? null;
  const canRun =
    connected && loggedIn && departments !== null && (departments.length === 0 || deptCode !== null) && !running && !otherRunning && storage.restored;
  const runBlockedReason = !connected
    ? "保存先フォルダーにつないでください"
    : !loggedIn
      ? "楽楽精算にログインしてください"
      : departments === null
        ? "部門を読み込んでください"
        : otherRunning
          ? "別の書類の取得が動いています"
          : null;

  const preview = previewNo ? (items.find((i) => i.denpyo_no === previewNo) ?? null) : null;
  const pending = pendingNo ? (items.find((i) => i.denpyo_no === pendingNo && isPending(i)) ?? null) : null;
  const recompose = recomposeNo ? (items.find((i) => i.denpyo_no === recomposeNo && !isPending(i)) ?? null) : null;

  return (
    <main>
      <p className="mt-4 text-sm text-slate-600">
        楽楽精算で最終承認まで進んだ{kind.label}を、本体と添付書類を1つに結合して、選んだPCのフォルダーへ保存します。
        楽楽精算からの取得は folio のサーバーが行い、PDFの結合と保存はこのブラウザの中で行います (folio のサーバーには保存しません)。
      </p>

      {header}

      {storage.storageError && <p className={WARN_CLASS}>{storage.storageError}</p>}

      <div className="mt-6 space-y-4">
        {/* ---------- 保存先フォルダー ---------- */}
        <section className={SECTION_CLASS}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                保存先フォルダー
                <span className={SUBTITLE_CLASS}>PDFと取得の記録 (_記録) をこのフォルダーに置きます</span>
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {!supported
                  ? "このブラウザでは使えません"
                  : !handle
                    ? "まだ選んでいません"
                    : connection === "checking"
                      ? `「${handle.name}」につないでいます…`
                      : connected
                        ? (
                          <>
                            <span className="font-medium text-emerald-700">つながっています</span>
                            <span className="ml-2 text-xs text-slate-500">保存先: {handle.name}</span>
                          </>
                        )
                        : `前回選んだフォルダー: ${handle.name}`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {handle && !connected && (
                <button
                  type="button"
                  onClick={() => void connect(handle, true)}
                  disabled={!supported || connection === "checking" || !storage.restored}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  フォルダーにつなぐ
                </button>
              )}
              <button
                type="button"
                onClick={() => void chooseFolder()}
                disabled={!supported || connection === "checking" || running || !storage.restored}
                className={handle ? SECONDARY_BUTTON_CLASS : PRIMARY_BUTTON_CLASS}
              >
                {handle ? "別のフォルダーを選ぶ" : "保存先フォルダーを選ぶ"}
              </button>
            </div>
          </div>
          {!supported && <p className={WARN_CLASS}>{FOLDER_UNSUPPORTED_TEXT}</p>}
          {supported && !handle && (
            <p className="mt-2 text-sm text-slate-600">
              {kind.label}のPDFを置くフォルダー (例: ドキュメントの「{kind.label}」) を選んでください。
              今までPCのツールで使っていたフォルダーを選ぶと、同じ場所に保存されます。
            </p>
          )}
          {supported && handle && !connected && connection !== "checking" && (
            <p className="mt-2 text-xs text-slate-500">
              ブラウザが「このフォルダーの編集を許可しますか」と尋ねたら「許可」を選んでください。
              Chrome と Edge では「今後も許可」を選ぶと、次からは押さなくてもつながります。
            </p>
          )}
          {connectionError && <p className={ERROR_CLASS}>{connectionError}</p>}
          {connected && client && (
            <TenmatsuImportRecords
              kind={kind}
              client={client}
              disabled={running || otherRunning}
              onImported={(summary) => {
                void refreshListRef.current(client).then(() =>
                  setListNotice(
                    `今までの方式の記録を取り込みました (新しく加わった${kind.label} ${summary.added}件` +
                      (summary.pendingTaken > 0 ? `、保留 ${summary.pendingTaken}件` : "") +
                      ")",
                  ),
                );
              }}
            />
          )}
        </section>

        {/* ---------- 楽楽精算 ---------- */}
        <section className={SECTION_CLASS}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                楽楽精算
                <span className={SUBTITLE_CLASS}>ご自分のログインIDとパスワードでログインします</span>
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {loggedIn ? (
                  <>
                    <span className="font-medium text-emerald-700">ログインしています</span>
                    {userId && <span className="ml-2 text-xs text-slate-500">ID: {userId}</span>}
                  </>
                ) : (
                  "まだログインしていません"
                )}
              </p>
            </div>
            {loggedIn && (
              <button
                type="button"
                onClick={() => {
                  forgetLogin();
                  setDepartments(null);
                }}
                disabled={running}
                className={SECONDARY_BUTTON_CLASS}
              >
                ログアウト (パスワードを忘れる)
              </button>
            )}
          </div>

          {!loggedIn && (
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void login();
              }}
            >
              <label className="flex flex-col text-xs text-slate-600">
                ログインID
                <input
                  type="text"
                  value={userId}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setUserId(e.target.value)}
                  disabled={loginBusy}
                  className={`mt-1 w-48 ${INPUT_CLASS}`}
                />
              </label>
              <label className="flex flex-col text-xs text-slate-600">
                パスワード
                <input
                  type="password"
                  value={passwordInput}
                  autoComplete="off"
                  onChange={(e) => setPasswordInput(e.target.value)}
                  disabled={loginBusy}
                  className={`mt-1 w-48 ${INPUT_CLASS}`}
                />
              </label>
              <button type="submit" disabled={loginBusy || !userId.trim() || !passwordInput} className={PRIMARY_BUTTON_CLASS}>
                {loginBusy ? "ログインしています…" : "ログイン"}
              </button>
            </form>
          )}
          {!loggedIn && (
            <p className="mt-2 text-xs text-slate-500">
              パスワードは保存しません (このブラウザのメモリにだけ置き、画面を読み込み直すと消えます)。ログインIDだけをこのブラウザに保存します。
              楽楽精算は続けて失敗するとアカウントがロックされるので、ログインに失敗したときは自動でやり直しません。入力を確かめてから押し直してください。
            </p>
          )}
          {loggedIn && !hasPassword && (
            <p className="mt-2 text-xs text-slate-500">
              取得の途中でログインが切れたときは、パスワードを入れ直していただく必要があります。
            </p>
          )}
          {loginError && <p className={ERROR_CLASS}>{loginError}</p>}
        </section>

        {/* ---------- 取得 ---------- */}
        <section className={SECTION_CLASS}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">
                {kind.label}の取得
                <span className={SUBTITLE_CLASS}>最終承認まで進んだ{kind.label}を、本体と添付を1つに結合して保存します</span>
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {running && status ? (
                  <>
                    {stopping ? "いまの伝票が終わったら止めます…" : status.message || "取得しています"}
                    {status.current && <span className="ml-2 text-xs text-slate-500">処理中: {status.current}</span>}
                  </>
                ) : (
                  "1件あたり10秒ほどかかります。取得中にこの画面を離れても続きますが、ブラウザのタブを閉じると止まります。"
                )}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {loggedIn && departments !== null && departments.length > 0 && (
                <label className="flex items-center gap-1.5 text-sm text-slate-600">
                  部門
                  <select
                    value={deptCode ?? ""}
                    onChange={(e) => chooseDept(e.target.value)}
                    disabled={running}
                    className={INPUT_CLASS}
                  >
                    {departments.map((d) => (
                      <option key={d.code} value={d.code}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-1.5 text-sm text-slate-600">
                1回に取る件数
                <input
                  type="number"
                  inputMode="numeric"
                  min={RUN_LIMITS.min}
                  max={RUN_LIMITS.max}
                  value={maxInput}
                  autoComplete="off"
                  disabled={running}
                  onChange={(e) => setMaxInput(e.target.value)}
                  className={`w-20 ${INPUT_CLASS}`}
                />
                <span className="text-xs text-slate-500">
                  件 ({RUN_LIMITS.min}〜{RUN_LIMITS.max})
                </span>
              </label>
              {running ? (
                <button type="button" onClick={stopRun} disabled={stopping || starting} className={SECONDARY_BUTTON_CLASS}>
                  {stopping ? "止めています…" : "中止"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void startRun()}
                disabled={!canRun}
                title={runBlockedReason ?? undefined}
                aria-busy={running}
                className={PRIMARY_BUTTON_CLASS}
              >
                {running ? `取得中… (${status?.done ?? 0}/${status?.total ?? 0} 完了)` : `${kind.label}を取得`}
              </button>
            </div>
          </div>

          {loggedIn && departments !== null && departments.length === 0 && (
            <p className="mt-2 text-xs text-slate-500">このアカウントには部門の切り替えが無いので、部門を指定せずに取得します。</p>
          )}
          {loggedIn && departments === null && !loginError && (
            <p className="mt-2 text-xs text-slate-500">
              部門を読み込んでいません。
              <button type="button" onClick={() => void loadDepartments()} className="ml-1 cursor-pointer underline hover:text-slate-700">
                部門を読み込む
              </button>
            </p>
          )}
          {!canRun && !running && runBlockedReason && <p className="mt-2 text-xs text-slate-500">{runBlockedReason}</p>}

          <p className="mt-2 text-xs text-slate-500">
            添付のPDFと画像 (JPG・PNG) を本体と結合します。開くのにパスワードが要らない保護のかかったPDFも結合できます。
            Excel・Word・PowerPoint・メールの添付は結合できないので、その{kind.label}を保留にして、本体と結合できた添付だけのPDFをフォルダーの _保留 に置き、残りの取得は続けます。
            一覧の「{kind.text.resolveButton}」から、手でPDFにしたものを入れて確定してください (どうしても手に入らないときは、欠けたまま確定することもできます)。
            動画・音声は紙にできないので結合せず飛ばし、その行に「動画は未結合」と出します。
          </p>

          {running && deptLabel && <p className="mt-2 text-xs text-slate-500">部門: {deptLabel}</p>}
          {completion &&
            (completion.tone === "error" ? (
              <p className={ERROR_CLASS}>
                {completion.message}
                {status?.error_file ? ` (経緯は保存先フォルダーの ${status.error_file} に残しました)` : ""}
              </p>
            ) : completion.tone === "notice" ? (
              <p className={WARN_CLASS}>{completion.message}</p>
            ) : (
              <p className="mt-2 text-sm text-emerald-700">{completion.message}</p>
            ))}
          {runError && <p className={ERROR_CLASS}>{runError}</p>}
          {logLines.length > 0 && <TenmatsuRunLog lines={logLines} />}
        </section>

        {/* ---------- 一覧 ---------- */}
        <section className={SECTION_CLASS}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              取得済み一覧
              <span className={SUBTITLE_CLASS}>
                {items.length}件{!listFresh && items.length > 0 && " (前回このブラウザで見た内容です)"}
              </span>
            </h2>
            <button
              type="button"
              onClick={() => void refreshList()}
              disabled={!connected || listLoading}
              className={SECONDARY_BUTTON_CLASS}
            >
              {listLoading ? "読み込んでいます…" : "一覧を再読み込み"}
            </button>
          </div>

          {listNotice && <p className="mt-2 text-sm text-emerald-700">{listNotice}</p>}
          {listError && <p className={ERROR_CLASS}>{listError}</p>}
          {flagError && <p className={ERROR_CLASS}>{flagError}</p>}

          <TenmatsuList
            kind={kind}
            items={items}
            filter={listFilter}
            onFilterChange={setListFilter}
            showCompleted={showCompleted}
            onShowCompletedChange={setShowCompleted}
            recentNos={recentNos}
            savingNos={savingFlags}
            flagDisabledReason={flagDisabledReason}
            onToggleFlag={(no, flag, next) => void toggleFlag(no, flag, next)}
            canPreview={connected}
            onPreview={setPreviewNo}
            resolveDisabledReason={resolveDisabledReason}
            onResolvePending={setPendingNo}
            onRecompose={setRecomposeNo}
          />
        </section>

        {kind.showStaffSync && items.length > 0 && (
          <TenmatsuStaffSync items={items} listFresh={listFresh} disabled={running} />
        )}
      </div>

      {preview && (
        <TenmatsuPreviewDialog item={preview} saveDir={handle?.name ?? null} load={loadPdf} onClose={() => setPreviewNo(null)} />
      )}

      {pending && (
        <TenmatsuPendingDialog
          kind={kind}
          item={pending}
          complete={(files, slots, acceptMissing) => completePending(pending.denpyo_no, files, slots, acceptMissing)}
          retry={() => retryPending(pending.denpyo_no)}
          load={loadPdf}
          attachments={FOLDER_ATTACHMENTS}
          hint={FOLDER_OFFICE_HINT}
          onClose={() => setPendingNo(null)}
        />
      )}

      {recompose && (
        <TenmatsuPendingDialog
          kind={kind}
          item={recompose}
          mode="recompose"
          recompose={(files, slots) => recomposePending(recompose.denpyo_no, files, slots)}
          load={loadPdf}
          attachments={FOLDER_ATTACHMENTS}
          hint={FOLDER_OFFICE_HINT}
          onClose={() => setRecomposeNo(null)}
        />
      )}

      {(items.length > 0 || handle !== null || userIdSaved) && (
        <StorageBanner
          description={
            storage.canPersist
              ? `${kind.label}の取得済み一覧の写し (伝票No.・物件名 (施主名を含むことがあります)・申請者・支払先・金額・印)、保存先フォルダーの場所、楽楽精算のログインID、1回に取る件数、選んだ部門を、このブラウザ内にだけ保存しています (folio のサーバーには送りません)。楽楽精算のパスワードは保存しません。記録の正本は保存先フォルダーの _記録 にあり、一覧を消してもつなぎ直せば戻ります。PDFの実体も保存先フォルダーにあり、ブラウザには保存しません。共有の端末では、使い終わったら下のボタンで消してください。`
              : "このタブでは保存を停止しています (再読み込みすると復元を試み直せます)。"
          }
          detail={`取得済み ${items.length}件 (未完了 ${items.filter((i) => i.completed !== true).length}件)`}
          usageBytes={storage.usageBytes}
          fontInfo={storage.fontInfo}
          disabled={running}
          actions={[
            ...(items.length > 0 ? [{ label: "一覧を消去", onClick: () => void clearList(), danger: true }] : []),
            ...(handle !== null ? [{ label: "保存先フォルダーの登録を消す", onClick: () => void forgetFolder(), danger: true }] : []),
            ...(userIdSaved ? [{ label: "ログインIDの登録を消す", onClick: () => void forgetUserId(), danger: true }] : []),
          ]}
          onClearFont={storage.clearFont}
        />
      )}

      <footer className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-400">
        {kind.label}のPDFは楽楽精算から folio のサーバーを通ってこのブラウザに届き、選んだフォルダーにだけ保存されます
        (folio のサーバーには保存しません)。楽楽精算のパスワードはログインに使うだけで、どこにも保存しません。
      </footer>
    </main>
  );
}
