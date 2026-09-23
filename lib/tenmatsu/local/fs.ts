/**
 * 利用者が選んだ PC のフォルダーを読み書きする（File System Access API）。
 *
 * ★ブラウザの `FileSystemDirectoryHandle` を直接あちこちで触らない。ここに薄く包んで、
 *   ①パスを `string[]` で扱う ②失敗を利用者に伝わる形（FolderError）に直す、の2つだけを行う。
 *   テストでは同じ形のインメモリのフォルダーを渡す（tests/helpers/fake-fs.ts）。
 * ★書き込みは `createWritable()` → `close()`。ブラウザは一時ファイルに書いて close のときに
 *   置き換えるので、途中で失敗しても元のファイルは壊れない（移植元の「一時ファイル → os.replace」と同じ性質）。
 */

export interface WritableLike {
  write(data: Uint8Array | string): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface FileLike {
  size: number;
  lastModified: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FileHandleLike {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<FileLike>;
  createWritable(): Promise<WritableLike>;
}

export interface DirHandleLike {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterable<[string, DirHandleLike | FileHandleLike]>;
}

export type FolderErrorKind =
  /** そのファイル・フォルダーが無い */
  | "notFound"
  /** 選んだフォルダーそのものが無くなった（移動・削除された） */
  | "folderMissing"
  /** ほかのアプリで開かれていて書けない（Windows で PDF を開いているときなど） */
  | "conflict"
  /** 書き込みの許可が無い */
  | "permission"
  /** 空き容量が足りない */
  | "quota"
  /** 名前に使えない文字がある */
  | "invalidName"
  | "unknown";

export class FolderError extends Error {
  constructor(
    readonly kind: FolderErrorKind,
    message: string,
    readonly path: readonly string[] = [],
  ) {
    super(message);
    this.name = "FolderError";
  }
}

export type Path = readonly string[];

export interface EntryStat {
  kind: "file" | "directory";
  size: number;
  lastModified: number;
}

const INVALID_PART = /[\\/\u0000]/;

function checkPath(path: Path): void {
  for (const part of path) {
    if (part === "" || part === "." || part === ".." || INVALID_PART.test(part)) {
      throw new FolderError("invalidName", `フォルダーの中の名前に使えない文字があります: ${part || "(空)"}`, path);
    }
  }
}

const showPath = (path: Path) => path.join("/");

/** ブラウザの例外を、利用者に伝わる形に直す */
export function toFolderError(error: unknown, path: Path, action: string): FolderError {
  if (error instanceof FolderError) return error;
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  const where = path.length > 0 ? `「${showPath(path)}」` : "保存先フォルダー";
  switch (name) {
    case "NotFoundError":
      return new FolderError("notFound", `${where}が見つかりません`, path);
    case "NoModificationAllowedError":
    case "InvalidModificationError":
      return new FolderError(
        "conflict",
        `${where}を${action}ませんでした。ほかのアプリ（PDFの表示など）で開いていないか確かめて、閉じてからもう一度試してください`,
        path,
      );
    case "NotAllowedError":
    case "SecurityError":
      return new FolderError(
        "permission",
        `保存先フォルダーを${action}る許可がありません。「フォルダーにつなぐ」を押して許可してください`,
        path,
      );
    case "QuotaExceededError":
      return new FolderError("quota", `空き容量が足りないため${where}を${action}ませんでした`, path);
    case "TypeError":
      return new FolderError("invalidName", `${where}の名前に使えない文字があります`, path);
    case "TypeMismatchError":
      return new FolderError("unknown", `${where}はファイルとフォルダーの種類が違います`, path);
    default:
      return new FolderError("unknown", `${where}を${action}ませんでした（${name || "原因不明"}）`, path);
  }
}

/** 先頭の BOM を落とす（ほかのアプリで保存し直されていても読めるように） */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const absent = (error: FolderError) => error.kind === "notFound" || error.kind === "unknown";

export class FolderStore {
  constructor(readonly root: DirHandleLike) {}

  get name(): string {
    return this.root.name;
  }

  /** 選んだフォルダーがまだ使えるか。無くなっていれば folderMissing、許可が無ければ permission */
  async probe(): Promise<void> {
    try {
      for await (const _entry of this.root.entries()) break;
    } catch (e) {
      const error = toFolderError(e, [], "読め");
      throw error.kind === "notFound"
        ? new FolderError("folderMissing", "保存先フォルダーが見つかりません（移動したか、名前が変わった可能性があります）。選び直してください")
        : error;
    }
  }

  private async dirAt(path: Path, create: boolean): Promise<DirHandleLike> {
    checkPath(path);
    let dir = this.root;
    for (const part of path) dir = await dir.getDirectoryHandle(part, { create });
    return dir;
  }

  private async fileAt(path: Path, create: boolean): Promise<FileHandleLike> {
    checkPath(path);
    if (path.length === 0) throw new FolderError("invalidName", "ファイル名がありません");
    const dir = await this.dirAt(path.slice(0, -1), create);
    return await dir.getFileHandle(path[path.length - 1], { create });
  }

  /** あるか・何か。無ければ null */
  async stat(path: Path): Promise<EntryStat | null> {
    checkPath(path);
    if (path.length === 0) return { kind: "directory", size: 0, lastModified: 0 };
    let parent: DirHandleLike;
    try {
      parent = await this.dirAt(path.slice(0, -1), false);
    } catch (e) {
      const error = toFolderError(e, path, "読め");
      if (absent(error)) return null;
      throw error;
    }
    const last = path[path.length - 1];
    try {
      const file = await (await parent.getFileHandle(last)).getFile();
      return { kind: "file", size: file.size, lastModified: file.lastModified };
    } catch (e) {
      const error = toFolderError(e, path, "読め");
      if (!absent(error)) throw error;
    }
    try {
      await parent.getDirectoryHandle(last);
      return { kind: "directory", size: 0, lastModified: 0 };
    } catch (e) {
      const error = toFolderError(e, path, "読め");
      if (absent(error)) return null;
      throw error;
    }
  }

  async exists(path: Path): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }

  async readBytes(path: Path): Promise<Uint8Array> {
    try {
      const file = await (await this.fileAt(path, false)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      throw toFolderError(e, path, "読め");
    }
  }

  async readText(path: Path): Promise<string> {
    return stripBom(new TextDecoder("utf-8").decode(await this.readBytes(path)));
  }

  /**
   * 書く（無ければフォルダーごと作る。あれば置き換える）。
   * ★置き換えは close のときに一度に起きる。途中で失敗したら abort して元のファイルを残す。
   */
  async writeBytes(path: Path, data: Uint8Array | string): Promise<void> {
    const existed = await this.exists(path);
    let writable: WritableLike | null = null;
    try {
      writable = await (await this.fileAt(path, true)).createWritable();
      await writable.write(data);
      await writable.close();
    } catch (e) {
      await writable?.abort?.().catch(() => undefined);
      // ★新しく作るファイルは、開いた時点で空のファイルができている。失敗したら消して「無い」状態に戻す
      //   （空のファイルが残ると、次に読んだときに壊れた記録に見えてしまう）
      if (!existed) await this.remove(path).catch(() => undefined);
      throw toFolderError(e, path, "書け");
    }
  }

  /**
   * フォルダーの中のファイルを、大きさと更新日時つきで返す（サブフォルダーは含めない）。
   * ★一覧で持っているハンドルから読むので、名前ごとに探し直さない。読めないファイルは飛ばす。
   */
  async listFiles(path: Path): Promise<{ name: string; size: number; lastModified: number }[]> {
    let dir: DirHandleLike;
    try {
      dir = await this.dirAt(path, false);
    } catch (e) {
      const error = toFolderError(e, path, "読め");
      if (absent(error)) return [];
      throw error;
    }
    const out: { name: string; size: number; lastModified: number }[] = [];
    try {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== "file") continue;
        try {
          const file = await handle.getFile();
          out.push({ name, size: file.size, lastModified: file.lastModified });
        } catch {
          // その間に消えた・ほかのアプリが掴んでいる、は候補にしないだけ
        }
      }
    } catch (e) {
      throw toFolderError(e, path, "読め");
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** 中の名前（名前順）。フォルダーが無ければ空 */
  async list(path: Path): Promise<{ name: string; kind: "file" | "directory" }[]> {
    let dir: DirHandleLike;
    try {
      dir = await this.dirAt(path, false);
    } catch (e) {
      const error = toFolderError(e, path, "読め");
      if (absent(error)) return [];
      throw error;
    }
    const out: { name: string; kind: "file" | "directory" }[] = [];
    try {
      for await (const [name, handle] of dir.entries()) out.push({ name, kind: handle.kind });
    } catch (e) {
      throw toFolderError(e, path, "読め");
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** 消す。無ければ何もしない（recursive を付けないと、中身のあるフォルダーは消せない） */
  async remove(path: Path, options: { recursive?: boolean } = {}): Promise<void> {
    if (path.length === 0) throw new FolderError("invalidName", "保存先フォルダーそのものは消せません");
    let parent: DirHandleLike;
    try {
      parent = await this.dirAt(path.slice(0, -1), false);
    } catch (e) {
      const error = toFolderError(e, path, "消せ");
      if (error.kind === "notFound") return;
      throw error;
    }
    try {
      await parent.removeEntry(path[path.length - 1], { recursive: options.recursive ?? false });
    } catch (e) {
      const error = toFolderError(e, path, "消せ");
      if (error.kind === "notFound") return;
      throw error;
    }
  }

  async copyFile(from: Path, to: Path): Promise<void> {
    await this.writeBytes(to, await this.readBytes(from));
  }

  /** フォルダーを中身ごと写す（写し先にあったものは残る。空にしたければ先に消す） */
  async copyDir(from: Path, to: Path): Promise<void> {
    try {
      await this.dirAt(to, true);
    } catch (e) {
      throw toFolderError(e, to, "作れ");
    }
    for (const entry of await this.list(from)) {
      if (entry.kind === "directory") await this.copyDir([...from, entry.name], [...to, entry.name]);
      else await this.copyFile([...from, entry.name], [...to, entry.name]);
    }
  }

  /**
   * フォルダーを移す（写してから元を消す）。
   * ★移し先が残っていると中へ入れてしまうので、**先に移し先を消す**（移植元 824-826 と同じ規則）。
   */
  async moveDir(from: Path, to: Path): Promise<void> {
    await this.remove(to, { recursive: true });
    await this.copyDir(from, to);
    await this.remove(from, { recursive: true });
  }
}
