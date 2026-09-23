"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { BlockedReason } from "@/components/blocked-reason";
import { FlowSteps } from "@/components/flow-steps";
import { MoreDetails } from "@/components/more-details";
import { StorageBanner } from "@/components/storage-banner";
import { SAVE_PAUSED_TEXT } from "@/lib/privacy-notes";
import { TenmatsuImportRecords } from "@/components/tenmatsu/tenmatsu-import-records";
import { TenmatsuList } from "@/components/tenmatsu/tenmatsu-list";
import { TenmatsuPendingDialog } from "@/components/tenmatsu/tenmatsu-pending-dialog";
import { TenmatsuPreviewDialog } from "@/components/tenmatsu/tenmatsu-preview-dialog";
import { TenmatsuRelinkDialog } from "@/components/tenmatsu/tenmatsu-relink-dialog";
import { TenmatsuRunLog } from "@/components/tenmatsu/tenmatsu-run-log";
import { TenmatsuStaffSync } from "@/components/tenmatsu/tenmatsu-staff-sync";
import { TenmatsuSurvey } from "@/components/tenmatsu/tenmatsu-survey";
import { ROUTE_LABELS } from "@/lib/rakuraku/kinds";
import { accountRouteText, routeNoticeText, routeOptionLabel, routeOptions } from "@/lib/rakuraku/parse/route";
import { type DepartmentOption, type RouteId, isRouteId } from "@/lib/rakuraku/protocol";
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
import {
  DOC_KIND_BY_ID,
  type DocKindId,
  clearListConfirmText,
  clearedNoticeText,
  flagErrorText,
  legacyFilePrefix,
  saveNote,
} from "@/lib/tenmatsu/kinds";
import type { ListFilter, ListSort } from "@/lib/tenmatsu/list-view";
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
import {
  DEPT_OPTIONS_EMPTY_TEXT,
  departmentErrorText,
  departmentFixFromStatus,
  pickDepartment,
  readDepartments,
  shouldAutoLoadDepartments,
} from "@/lib/tenmatsu/local/departments";
import {
  type TenmatsuFlowInput,
  canStartRun,
  composeDetails,
  composeSummary,
  folderBlockedReason,
  isFreshTenmatsu,
  listEmptyText,
  runBlockedReason,
  tenmatsuFlow,
  tenmatsuStepDefs,
} from "@/lib/tenmatsu/local/flow";
import { LOCAL_KINDS, RUN_LIMITS } from "@/lib/tenmatsu/local/kind-config";
import { loadSharedFolderHandle } from "@/lib/shared/store";
import { useSharedSyncOnOpen } from "@/lib/shared/use-shared-folder";
import { sharedOverlap, sharedOverlapText } from "@/lib/tenmatsu/local/folder-guard";
import {
  RAKURAKU_CHIP_ID,
  getLoginDialogState,
  isLoginDismissedInTab,
  openLoginDialog,
  shouldAutoOpenLogin,
  shouldPromptOnSessionLost,
} from "@/lib/rakuraku-login-dialog";
import { createRakurakuApi, RakurakuApiError } from "@/lib/tenmatsu/local/server-api";
import {
  type FolderConnection,
  forgetLogin,
  getFolderSession,
  getLoginUserId,
  getPassword,
  getSessionToken,
  getViewTab,
  keepFolderSession,
  rememberDepartments,
  restoreLogin,
  restoredDepartments,
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
  loadRoutePin,
  loadUserId,
  saveDept,
  saveFolderHandle,
  saveFolderList,
  saveMaxPerRun,
  saveRoutePin,
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
 *   封じたログイン状態だけはこのタブに残るので、再読み込みしてもログインしたまま（lib/tenmatsu/local/session.ts）。
 * ★フォルダーを使う許可を尋ねるのは、ボタンを押したときだけ（読み込み直後に尋ねるとブラウザが断る）。
 * ★取得はこの画面を離れても続く。ブラウザのタブを閉じると止まる。
 */
/**
 * ★今までの方式 (PCのツール) の記録を取り込む欄を出すかどうか。
 * 移行が済んだので false にして画面から外している。
 * また使うときはここを true にするだけでよい (取り込みの仕組みは消していない。
 * components/tenmatsu/tenmatsu-import-records.tsx と lib/tenmatsu/local/import.ts)。
 */
const SHOW_IMPORT: boolean = false;

export function TenmatsuFolderPage({ kind: kindId, header }: { kind: DocKindId; header?: ReactNode }) {
  const kind = DOC_KIND_BY_ID[kindId];
  const kept = getFolderSession(kind.id);
  /**
   * 共有フォルダー（データベースの役割。つながりは Folio 全体で1つ）。
   * ★監督・営業を顧客データへ反映する顛末書だけが、開いたときに相手の分を取り込む。
   *   専決決裁書・捺印決裁書では同期しない（共有フォルダーのデータを使わないため）。
   */
  useSharedSyncOnOpen(kind.showStaffSync);
  /** この種類で選べる一覧の経路（1つしか無ければ選択は出さない） */
  const ROUTES = routeOptions(kind.id);

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
  const [listSort, setListSort] = useState<ListSort>(kept.listSort);
  const [maxInput, setMaxInput] = useState(kept.maxInput);

  const [userId, setUserId] = useState("");
  /** ログインIDをこのブラウザに保存してあるか（入力しただけでは消去の導線を出さない） */
  const [userIdSaved, setUserIdSaved] = useState(false);
  const [loggedIn, setLoggedIn] = useState(getSessionToken() !== null);
  const [departments, setDepartments] = useState<DepartmentOption[] | null>(kept.departments);
  const [deptCode, setDeptCode] = useState<string | null>(kept.deptCode);
  /** ★部門の失敗はログインの失敗と分ける。混ぜると、やり直しの導線まで隠れて行き止まりになる */
  const [deptError, setDeptError] = useState<string | null>(null);
  const [deptBusy, setDeptBusy] = useState(false);
  /** 部門を読めないまま「指定せずに取得する」を選んだか */
  const [skipDepartment, setSkipDepartment] = useState(kept.skipDepartment);
  /** ログインしたアカウントに「閲覧」タブがあるか。null＝分からない（古いサーバー） */
  const [viewTab, setViewTab] = useState<boolean | null>(getViewTab());
  /** 「このアカウントはどの経路から取るか」の1行（判定できていないときは null） */
  const accountRoute = accountRouteText(kind.id, viewTab);
  const deptBusyRef = useRef(false);
  /** このログインで、画面が勝手に部門を読みに行ったか（失敗したあとは押したときだけ読む） */
  const deptAutoRef = useRef(false);
  /** 一覧の経路の固定（null なら自動で順に試す） */
  const [routePin, setRoutePin] = useState<RouteId | null>(kept.routePin);
  const deptCodeRef = useRef(deptCode);
  deptCodeRef.current = deptCode;
  const routePinRef = useRef(routePin);
  routePinRef.current = routePin;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  const [previewNo, setPreviewNo] = useState<string | null>(null);
  const [pendingNo, setPendingNo] = useState<string | null>(null);
  const [recomposeNo, setRecomposeNo] = useState<string | null>(null);
  /** 「PDFを選ぶ」で選び直している伝票 */
  const [relinkNo, setRelinkNo] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  // サーバーで描くときは window が無いので、ブラウザに来てから判定する
  useEffect(() => {
    setSupported(isFolderAccessSupported());
  }, []);

  // ヘッダーのログインの画面・ほかの種類のタブでログインした・忘れたときも、この画面の表示を揃える
  useEffect(() => {
    const sync = () => {
      const token = getSessionToken();
      setLoggedIn(token !== null);
      // 「閲覧」タブの有無も揃える（再読み込みで戻したとき・別の種類のタブでログインしたとき）
      setViewTab(getViewTab());
      // ログインの画面で入れたIDを写す（取得のときの auth.userId と、登録を消す導線に使う）
      const id = getLoginUserId();
      if (id !== null) {
        setUserId(id);
        setUserIdSaved(true);
      }
      if (token === null) {
        deptAutoRef.current = false;
        setDepartments((prev) => (prev === null ? prev : null));
        return;
      }
      // 再読み込みの前に読んでいた部門の選択肢を戻す (楽楽精算へ読みに行かずに済む)
      const remembered = restoredDepartments(kind.id);
      if (remembered) {
        setDepartments((prev) => prev ?? remembered.departments);
        setDeptCode((prev) => prev ?? remembered.deptCode);
      }
    };
    const unsubscribe = subscribeLogin(sync);
    // ★このタブに残したログイン状態を戻す。描いたあとで行う (サーバーで描いた HTML と揃えるため)。
    //   restoreLogin は一度しか戻さず、先にマウントするヘッダーが使い切るので、必ず後で読み直す
    restoreLogin();
    sync();
    // ★未ログインならログインの画面を出す。**出すだけで、ログインはしない**
    //   （閉じたら、このタブでは自分で開くまでもう出さない）
    if (
      shouldAutoOpenLogin({
        kind: kind.id,
        loggedIn: getSessionToken() !== null,
        dismissedInTab: isLoginDismissedInTab(),
        alreadyOpen: getLoginDialogState().open,
      })
    ) {
      openLoginDialog("auto", kind.id);
    }
    return unsubscribe;
  }, []);

  // ★ログインできたら、部門は画面が勝手に読みに行く。部門の切り替えが無いアカウントは、
  //   何も押さずにこの手順を通り過ぎる（押さないと進めない小さなボタンを出さない）。
  //   失敗したあとは自動で読み直さない（「もう一度読み込む」を押したときだけ）。
  useEffect(() => {
    const auto = shouldAutoLoadDepartments({
      loggedIn,
      loaded: departments !== null,
      busy: deptBusy,
      failed: deptError !== null,
      skipped: skipDepartment,
      tried: deptAutoRef.current,
    });
    if (!auto) return;
    deptAutoRef.current = true;
    void loadDepartments();
  }, [loggedIn, departments, deptBusy, deptError, skipDepartment]);

  // 部門の選択肢と選んだ部門をタブに覚える (再読み込みしても選び直さずに済むように)
  useEffect(() => {
    if (loggedIn && departments !== null) rememberDepartments(kind.id, departments, deptCode);
  }, [loggedIn, departments, deptCode]);

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
      try {
        setRoutePin(await loadRoutePin(kind.id));
      } catch (e) {
        partialErrors.push(`一覧の経路: ${errorText(e)}`);
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
      // ★名前を変えられたPDFは、中身で見つけて記録を今の名前に結び直す（lib/tenmatsu/local/relink.ts）
      const { items: fresh, relinked } = await target.listWithRelinks();
      setItems(fresh);
      setListFresh(true);
      setRecentNos(new Set());
      storage.persist(() => saveFolderList(kind.id, fresh));
      if (relinked.length > 0) {
        const first = relinked[0];
        setListNotice(
          `名前が変わっていた${kind.label} ${relinked.length}件の記録を、今の名前につなぎ直しました` +
            ` (${first.from} → ${first.to}${relinked.length > 1 ? ` ほか${relinked.length - 1}件` : ""})`,
        );
      }
      // 以前の記録に中身の指紋を付ける（これから名前を変えても自動で結び直るように）。急がない
      void target.backfillFingerprints().catch(() => undefined);
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
          setToken: (token) => {
            setLogin({ sessionToken: token });
            // ★パスワードがメモリにあれば job.ts がこの実行の中で1回だけ入り直すので、邪魔をしない
            if (token === null && shouldPromptOnSessionLost({ during: "run", hasPassword: getPassword() !== null })) {
              openLoginDialog("session-lost", kind.id);
            }
          },
        },
        deptCode: () => deptCodeRef.current,
        routePin: () => routePinRef.current,
        statsCache: idbStatsCache(kind.id),
      }),
    [kind.id],
  );

  /** フォルダーにつなぐ。askPermission は「ボタンを押した処理の中」でだけ true にする */
  /**
   * 保存先が Box の共有フォルダーの中（または共有フォルダーを含む）なら、理由の文を返す。
   * ★楽楽精算は人によって見られる伝票が違うので、PDF を共有の場所に置かせない（lib/tenmatsu/local/folder-guard.ts）。
   */
  const sharedOverlapReason = async (dir: BrowserDirHandle): Promise<string | null> => {
    const shared = await loadSharedFolderHandle().catch(() => null);
    const overlap = await sharedOverlap(dir, shared);
    return overlap ? sharedOverlapText(kind, overlap) : null;
  };

  const connect = async (dir: BrowserDirHandle, askPermission: boolean) => {
    setConnection("checking");
    setConnectionError(null);
    try {
      // ★前に選んでいた保存先でも確かめる（この見張りを入れる前に、共有フォルダーの中を選んでいた人のため）
      const blocked = await sharedOverlapReason(dir);
      if (blocked) {
        setClient(null);
        setConnection("error");
        setConnectionError(blocked);
        return;
      }
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
      // ★共有フォルダーの中は、保存先として覚えもしない
      const blocked = await sharedOverlapReason(picked);
      if (blocked) {
        setConnection("error");
        setConnectionError(blocked);
        return;
      }
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

  /**
   * 部門を読む。規則（やり直し・3通りの結果）は lib/tenmatsu/local/departments.ts にある。
   * ★ここでは loginError を書かない。書くと、やり直しの導線まで隠れて行き止まりになっていた。
   */
  const loadDepartments = async () => {
    const token = getSessionToken();
    if (!token || deptBusyRef.current) return; // ★二重押しで呼び出しを増やさない
    deptBusyRef.current = true;
    setDeptBusy(true);
    setDeptError(null);
    try {
      const outcome = await readDepartments({ api }, token);
      if (outcome.kind !== "failed" && outcome.sessionToken) {
        setLogin({
          sessionToken: outcome.sessionToken,
          ...(outcome.expiresAt !== null ? { expiresAt: outcome.expiresAt } : {}),
        });
      }
      if (outcome.kind !== "failed") setSkipDepartment(false);
      switch (outcome.kind) {
        case "list": {
          const saved = await loadDept(kind.id).catch(() => null);
          setDepartments(outcome.departments);
          setDeptCode(pickDepartment(outcome.departments, saved?.code ?? null, outcome.current?.code ?? null)?.code ?? null);
          return;
        }
        case "none":
          // 部門の切り替えが無いアカウント。部門を指定せずに取得する
          setDepartments([]);
          setDeptCode(null);
          return;
        case "empty":
          // ★このまま取得しても取得開始時に止まるので、取得は許さない（departments は null のまま）
          setDeptError(DEPT_OPTIONS_EMPTY_TEXT);
          return;
        case "failed":
          if (outcome.sessionLost) {
            setLogin({ sessionToken: null });
            if (shouldPromptOnSessionLost({ during: "departments", hasPassword: getPassword() !== null })) {
              openLoginDialog("session-lost", kind.id);
            }
          }
          setDeptError(departmentErrorText(outcome));
          return;
      }
    } finally {
      deptBusyRef.current = false;
      setDeptBusy(false);
    }
  };

  const chooseDept = (code: string) => {
    const found = departments?.find((d) => d.code === code);
    if (!found) return;
    setDeptCode(code);
    storage.persist(() => saveDept(kind.id, found));
  };

  /** 一覧の経路。空文字は「自動」（閲覧 → ワークフローの順に試す） */
  const chooseRoute = (value: string) => {
    const next = isRouteId(value) ? value : null;
    setRoutePin(next);
    storage.persist(() => saveRoutePin(kind.id, next));
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
          // ★「部門を指定せず」で始めたが、実は部門を選べるアカウントだった場合。
          //   取得は止まっているので、選べる部門を画面に出して選び直してもらう
          const fix = departmentFixFromStatus(s);
          if (fix) {
            setDepartments(fix.departments);
            setDeptCode(fix.deptCode);
            setSkipDepartment(false);
            setDeptError("部門を指定せずに取得しようとしましたが、このアカウントには部門の切り替えがありました。部門を選んでから、もう一度取得してください");
          }
          if (isFinished(s.state)) {
            setStopping(false);
            // ★入り直せずに終わったときは、ここでログインの画面を出す（出すだけ）
            if (
              getSessionToken() === null &&
              shouldPromptOnSessionLost({ during: "run-end", hasPassword: getPassword() !== null })
            ) {
              openLoginDialog("session-lost", kind.id);
            }
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

  /** 以前の表記の保存名を、いまの表記（№）にまとめて直す */
  const renameLegacyNames = async () => {
    if (!client) return;
    if (
      !confirm(
        `以前の表記で保存した${kind.label}のPDFの名前を「${kind.filePrefix}…」に直します。\n` +
          "PDFの中身は変わりません。クラウドへ上げたファイルの名前とは違う名前になります。よろしいですか？",
      )
    ) {
      return;
    }
    setRenaming(true);
    try {
      const { renamed, skipped } = await client.renameLegacyNames();
      await refreshListRef.current();
      setListNotice(
        `${renamed}件の保存名を「${kind.filePrefix}…」に直しました` +
          (skipped.length > 0 ? `（${skipped.length}件はそのままです: ${skipped[0].reason}）` : ""),
      );
    } catch (e) {
      setListError(`保存名を直せませんでした (${errorText(e)})`);
    } finally {
      setRenaming(false);
    }
  };

  // 「PDFを選ぶ」ダイアログに渡す読み込み（ダイアログの中で何度も作り直さないよう固定する）
  const loadRelinkCandidates = useCallback(() => {
    if (!client || !relinkNo) return Promise.reject(new Error("保存先フォルダーにつないでください"));
    return client.relinkCandidates(relinkNo);
  }, [client, relinkNo]);
  const loadCandidatePdf = useCallback(
    (name: string) => {
      if (!client || !relinkNo) return Promise.reject(new Error("保存先フォルダーにつないでください"));
      return client.candidatePdf(relinkNo, name);
    },
    [client, relinkNo],
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
      listSort,
      status,
      runObserved,
      logLines,
      maxInput,
      departments,
      deptCode,
      skipDepartment,
      routePin,
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
  /** 手順バーと「押せない理由」のもと。規則は lib/tenmatsu/local/flow.ts にまとめてある */
  const flowInput: TenmatsuFlowInput = {
    kind,
    supported,
    restored: storage.restored,
    hasHandle: handle !== null,
    handleName: handle?.name ?? null,
    connection,
    connected,
    loggedIn,
    // ★ログインはモーダルで行うので、この画面が「ログイン中」になることはない
    loginBusy: false,
    departmentCount: departments?.length ?? null,
    deptLabel,
    departmentFailed: deptError !== null && departments === null,
    departmentSkipped: skipDepartment,
    running,
    otherRunKind: otherRunning ? otherRunKind : null,
    itemCount: items.length,
    userIdSaved,
  };
  const canRun = canStartRun(flowInput);
  const runBlocked = runBlockedReason(flowInput);
  const steps = tenmatsuStepDefs(kind);
  const sectionId = (id: string) => steps.find((s) => s.id === id)?.targetId;
  /**
   * 手順②や「→ ログイン」を押したときに、ログインの画面を開く。
   * ★楽楽精算の欄はこの画面から無くしたので、行き先はヘッダーの表示とこの画面だけ。
   *   ログイン済みでも開く（ログイン状態の確認とログアウトができる）。開くだけでログインはしない。
   */
  const openLoginFor = (targetId: string) => {
    if (targetId === RAKURAKU_CHIP_ID) openLoginDialog("manual", kind.id);
  };

  const preview = previewNo ? (items.find((i) => i.denpyo_no === previewNo) ?? null) : null;
  const pending = pendingNo ? (items.find((i) => i.denpyo_no === pendingNo && isPending(i)) ?? null) : null;
  const recompose = recomposeNo ? (items.find((i) => i.denpyo_no === recomposeNo && !isPending(i)) ?? null) : null;
  const relinkItem = relinkNo ? (items.find((i) => i.denpyo_no === relinkNo && !isPending(i)) ?? null) : null;
  /** 以前の表記（顛末書No.…）のまま保存されているPDFの数 */
  const legacyNameCount = items.filter((i) => !isPending(i) && i.exists && i.file.startsWith(legacyFilePrefix(kind))).length;

  return (
    <main>
      <p className="mt-4 text-sm text-slate-600">
        {/* ★保存とパスワードの話は画面のいちばん下（保存の欄）にまとめた。ここでは繰り返さない */}
        楽楽精算で最終承認まで進んだ{kind.label}を、本体と添付書類を1つのPDFにまとめて、選んだPCのフォルダーへ保存します。
      </p>

      {header}

      <FlowSteps
        plan={tenmatsuFlow(flowInput)}
        ariaLabel={`${kind.label}の手順`}
        expanded={isFreshTenmatsu(flowInput)}
        helpSlug={kind.id}
        onStepClick={(step) => openLoginFor(step.targetId)}
      />

      {storage.storageError && <p className={WARN_CLASS}>{storage.storageError}</p>}

      <div className="mt-6 space-y-4">
        {/* ---------- 保存先フォルダー ---------- */}
        <section id={sectionId("folder")} tabIndex={-1} className={`${SECTION_CLASS} scroll-mt-4`}>
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
                title={folderBlockedReason(flowInput) ?? undefined}
                className={handle ? SECONDARY_BUTTON_CLASS : PRIMARY_BUTTON_CLASS}
              >
                {handle ? "別のフォルダーを選ぶ" : "保存先フォルダーを選ぶ"}
              </button>
            </div>
          </div>
          {/* 対応していないブラウザは下に大きく出しているので、ここでは出さない */}
          <BlockedReason reason={supported ? folderBlockedReason(flowInput) : null} className="mt-2" />
          {!supported && <p className={WARN_CLASS}>{FOLDER_UNSUPPORTED_TEXT}</p>}
          {supported && !handle && (
            <p className="mt-2 text-sm text-slate-600">
              {kind.label}のPDFを置くフォルダー (例: ドキュメントの「{kind.label}」) を選んでください。
            </p>
          )}
          {supported && handle && !connected && connection !== "checking" && (
            <p className="mt-2 text-xs text-slate-500">
              ブラウザが「このフォルダーの編集を許可しますか」と尋ねたら「許可」を選んでください。
            </p>
          )}
          {connectionError && <p className={ERROR_CLASS}>{connectionError}</p>}
          {SHOW_IMPORT && connected && client && (
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

        {/* ---------- 取得 ---------- */}
        <section id={sectionId("run")} tabIndex={-1} className={`${SECTION_CLASS} scroll-mt-4`}>
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
              {/* ★「閲覧」タブの有無が分かるときは経路を選ばせない（自動で決まる）。
                  分からない古いサーバーのときだけ、今までどおり選べるようにしておく */}
              {loggedIn && viewTab === null && ROUTES.length > 1 && (
                <label className="flex items-center gap-1.5 text-sm text-slate-600">
                  一覧の経路
                  <select
                    value={routePin ?? ""}
                    onChange={(e) => chooseRoute(e.target.value)}
                    disabled={running}
                    className={INPUT_CLASS}
                  >
                    <option value="">
                      自動（{ROUTE_LABELS.jibumon} → {ROUTE_LABELS.shinsei}）
                    </option>
                    {ROUTES.map((r) => (
                      <option key={r.id} value={r.id}>
                        {routeOptionLabel(r)}
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
                title={runBlocked?.text ?? undefined}
                aria-busy={running}
                className={PRIMARY_BUTTON_CLASS}
              >
                {running ? `取得中… (${status?.done ?? 0}/${status?.total ?? 0} 完了)` : `${kind.label}を取得`}
              </button>
            </div>
          </div>

          {/* ★ログインした時点で分かる「閲覧」タブの有無。一覧の経路はこれで決まり、
              **取れる伝票の範囲が変わる**ので、取得を押す場所のすぐ近くに出す */}
          {loggedIn && accountRoute && <p className="mt-2 text-xs text-slate-500">{accountRoute}</p>}
          {loggedIn && departments !== null && departments.length === 0 && (
            <p className="mt-2 text-xs text-slate-500">このアカウントには部門の切り替えが無いので、部門を指定せずに取得します。</p>
          )}
          {/* ★部門を読めなかったときの逃げ道。指定せずに取得しても、取得の開始時に
              楽楽精算で「本当に切り替えが無いか」を確かめ直すので、別の部門の伝票は取らない */}
          {loggedIn && skipDepartment && departments === null && (
            <p className={WARN_CLASS}>
              部門を指定せずに取得します。部門の切り替えがあるアカウントだったときは、取得を始めた時点で止まります（別の部門の伝票は取りません）。
              <button
                type="button"
                onClick={() => {
                  setSkipDepartment(false);
                  void loadDepartments();
                }}
                disabled={running || deptBusy}
                className="ml-2 cursor-pointer underline hover:text-amber-950 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
              >
                部門を読み込み直す
              </button>
            </p>
          )}
          {loggedIn && deptError && !deptBusy && <p className={ERROR_CLASS}>{deptError}</p>}
          {loggedIn && departments === null && deptError && !deptBusy && !skipDepartment && (
            <>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void loadDepartments()}
                  disabled={running}
                  className={SECONDARY_BUTTON_CLASS}
                >
                  もう一度読み込む
                </button>
                {/* 選択肢が空のときは出さない（指定せずに取得しても、取得開始時に必ず止まるため） */}
                {deptError !== DEPT_OPTIONS_EMPTY_TEXT && (
                  <button
                    type="button"
                    onClick={() => {
                      setSkipDepartment(true);
                      setDeptCode(null);
                      setDeptError(null);
                    }}
                    disabled={running}
                    className={SECONDARY_BUTTON_CLASS}
                  >
                    部門を指定せずに取得する
                  </button>
                )}
              </div>
              <p className="mt-2 text-xs text-slate-500">
                「部門を指定せずに取得する」を選ぶと、楽楽精算がそのアカウントに見せている部門のまま取得します。
                部門の切り替えがあるアカウントだった場合は、取得を始めた時点で止まります（別の部門の伝票は取りません）。
              </p>
            </>
          )}
          {/* ★読み込みは自動なので、押すものは出さない（失敗したときだけ上の2つのボタンが出る） */}
          {loggedIn && departments === null && !deptError && !skipDepartment && (
            <p className="mt-2 text-xs text-slate-500">部門を読み込んでいます…</p>
          )}
          <BlockedReason
            reason={!canRun && !running ? (runBlocked?.text ?? null) : null}
            targetId={runBlocked?.targetId}
            targetLabel={runBlocked?.targetLabel}
            onTarget={openLoginFor}
            className="mt-2"
          />

          {/* この種類だけの進み方（捺印決裁書は取得しただけでは終わらない） */}
          {kind.text.flowNote && <p className="mt-2 text-sm text-slate-600">{kind.text.flowNote}</p>}

          {/* ★一覧をどの経路でも開けないときの手当て。畳んであるので普段は目に入らない */}
          {loggedIn && (
            <TenmatsuSurvey
              api={api}
              sessionToken={getSessionToken()}
              deptCode={deptCode}
              onSession={(token) => setLogin({ sessionToken: token })}
              disabled={running || otherRunning}
              disabledReason={running || otherRunning ? "取得が終わってから実行してください" : undefined}
            />
          )}

          {/* ★何を1つのPDFにするかは1文だけ。保留・動画・保護のかかったPDFの話は「くわしく」に入れる
              （以前は5文が常に並んでいて読み飛ばされていた）。文は lib/tenmatsu/local/flow.ts にある */}
          <div className="mt-2 text-xs text-slate-500">
            {composeSummary(kind)}
            <MoreDetails size="xs">
              {[...kind.text.flowDetails, ...composeDetails(kind)].map((text) => (
                <p key={text}>{text}</p>
              ))}
            </MoreDetails>
          </div>

          {running && deptLabel && <p className="mt-2 text-xs text-slate-500">部門: {deptLabel}</p>}
          {/* ★どの経路で取ったかは取得中も完了後も出す（経路によって一覧に出る伝票の範囲が違う） */}
          {status?.route && (
            <p className={status.route.scope === "own" ? WARN_CLASS : "mt-2 text-xs text-slate-500"}>
              {routeNoticeText(kind.label, status.route)}
            </p>
          )}
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
        <section id={sectionId("list")} tabIndex={-1} className={`${SECTION_CLASS} scroll-mt-4`}>
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
              title={!connected ? "保存先フォルダーにつなぐと読み込めます" : undefined}
              className={SECONDARY_BUTTON_CLASS}
            >
              {listLoading ? "読み込んでいます…" : "一覧を再読み込み"}
            </button>
          </div>

          {legacyNameCount > 0 && (
            <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              以前の表記（{legacyFilePrefix(kind)}…）で保存したPDFが {legacyNameCount}件あります。
              <button
                type="button"
                disabled={!connected || renaming || running || otherRunning}
                onClick={() => void renameLegacyNames()}
                className="ml-2 cursor-pointer underline hover:text-amber-950 disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
              >
                {renaming ? "直しています…" : `保存名を「${kind.filePrefix}…」に直す`}
              </button>
            </p>
          )}
          {listNotice && <p className="mt-2 text-sm text-emerald-700">{listNotice}</p>}
          {listError && <p className={ERROR_CLASS}>{listError}</p>}
          {flagError && <p className={ERROR_CLASS}>{flagError}</p>}

          <TenmatsuList
            kind={kind}
            items={items}
            connected={connected}
            filter={listFilter}
            onFilterChange={setListFilter}
            sort={listSort}
            onSortChange={setListSort}
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
            onRelink={setRelinkNo}
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

      {relinkItem && client && (
        <TenmatsuRelinkDialog
          kind={kind}
          item={relinkItem}
          loadCandidates={loadRelinkCandidates}
          loadPdf={loadCandidatePdf}
          relink={async (name) => {
            const updated = await client.relinkFile(relinkItem.denpyo_no, name);
            if (updated) setItems((prev) => prev.map((i) => (i.denpyo_no === updated.denpyo_no ? updated : i)));
            else await refreshListRef.current();
            setRecentNos((prev) => new Set(prev).add(relinkItem.denpyo_no));
            setListNotice(`伝票№ ${relinkItem.denpyo_no} の記録を「${name}」に結びました`);
          }}
          onClose={() => setRelinkNo(null)}
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

      {/* ★保存とパスワードの説明は、この欄だけに出す（リード文・ログイン欄・フッターの繰り返しはやめた）。
          そのため、まだ何も取得していない画面でも必ず出す */}
      {storage.restored && (
        <StorageBanner
          description={
            storage.canPersist ? (
              <>
                {saveNote(kind).summary}
                <MoreDetails size="xs" summary="くわしく (保存する中身とPDFの通り道)">
                  {saveNote(kind).details.map((text) => (
                    <p key={text}>{text}</p>
                  ))}
                </MoreDetails>
              </>
            ) : (
              SAVE_PAUSED_TEXT
            )
          }
          detail={
            items.length > 0
              ? `取得済み ${items.length}件 (未完了 ${items.filter((i) => i.completed !== true).length}件)`
              : undefined
          }
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

    </main>
  );
}
