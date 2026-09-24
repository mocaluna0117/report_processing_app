"use client";

/**
 * 問い合わせのモーダルの開け閉めと、書きかけの下書き。
 * ヘッダーの「問い合わせ」と、使い方のモーダルの「解決しないときは」の両方から開く
 * （lib/shared/dialog.ts と同じやり方）。
 *
 * ★下書きは**このタブのメモリにだけ**置く。閉じても消えず、送れたら消す。
 *   sessionStorage・localStorage には入れない（写真が大きいのと、お客様の情報が紛れることがあるため）。
 *   読み込み直すと消える。
 */
import { CONTACT_PAGES, type ContactCategoryId } from "@/lib/contact/form";

/** ヘッダーのボタンの目印 */
export const CONTACT_BUTTON_ID = "contact-button";

export interface ContactPhoto {
  id: string;
  /** 縮めたあとの写真（JPEG） */
  blob: Blob;
  /** サムネイル用（外すとき・送れたときに revoke する） */
  url: string;
  width: number;
  height: number;
}

export interface ContactDraft {
  category: ContactCategoryId;
  page: string;
  message: string;
  name: string;
  photos: ContactPhoto[];
  photosChecked: boolean;
}

const emptyDraft = (page: string): ContactDraft => ({
  category: "bug",
  page,
  message: "",
  name: "",
  photos: [],
  photosChecked: false,
});

/** 画面の選択肢に無い path（/login など）は「分からない」にする */
const knownPage = (path: string | null | undefined): string =>
  CONTACT_PAGES.some((p) => p.path === path) ? (path as string) : "";

let open = false;
let draft: ContactDraft = emptyDraft("");
const listeners = new Set<(open: boolean) => void>();

const notify = () => {
  for (const listener of listeners) listener(open);
};

export function isContactOpen(): boolean {
  return open;
}

export function subscribeContact(listener: (open: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 書きかけが無いか（無ければ、開いた画面とお名前を入れ直してよい） */
export function isDraftEmpty(d: ContactDraft): boolean {
  return d.message.trim() === "" && d.photos.length === 0;
}

/**
 * 開く。page は開いた画面（ヘッダーなら今の画面、使い方なら選んでいたタブ）。
 * ★書きかけがあるときは、前に選んだ画面のまま（書いている途中で勝手に変えない）。
 */
export function openContact(options: { page?: string | null; name?: string | null } = {}): void {
  if (isDraftEmpty(draft)) {
    // ★ログインしている人の表示名を最初から入れる（消して送ってもよい）
    draft = { ...draft, page: knownPage(options.page), name: (options.name ?? "").slice(0, 50) };
  }
  open = true;
  notify();
}

export function closeContact(): void {
  open = false;
  notify();
}

export function getContactDraft(): ContactDraft {
  return draft;
}

export function saveContactDraft(next: ContactDraft): void {
  draft = next;
}

/** 送れたら消す。写真のサムネイルも片付ける */
export function clearContactDraft(): void {
  for (const photo of draft.photos) {
    try {
      URL.revokeObjectURL(photo.url);
    } catch {
      // 片付けられなくても害は無い（タブを閉じれば消える）
    }
  }
  draft = emptyDraft(draft.page);
}

/** テスト用 */
export function resetContactForTests(): void {
  open = false;
  draft = emptyDraft("");
  listeners.clear();
}
