import type { DirHandleLike, FileHandleLike, FileLike, WritableLike } from "@/lib/tenmatsu/local/fs";

/**
 * インメモリのフォルダー（File System Access API の `FileSystemDirectoryHandle` と同じ振る舞いの一部）。
 *
 * 本物に合わせてあること:
 *   - 無いものを開くと NotFoundError、ファイルとフォルダーを取り違えると TypeMismatchError
 *   - createWritable() に書いた内容は **close() のときに初めて**置き換わる（abort すれば元のまま）
 *   - 中身のあるフォルダーを recursive なしで消すと InvalidModificationError
 * 検証のための仕掛け:
 *   - lock(path)      … そのファイルへの書き込みを NoModificationAllowedError にする（ほかのアプリで開いている）
 *   - failClose(path) … 次の close() を失敗させる（書いている途中で落ちた）
 *   - vanish()        … フォルダーそのものを無くす（移動・削除された）
 *   - deny()          … 許可を取り消す（NotAllowedError）
 */
type Node = FakeDir | FakeFile;

const domError = (name: string, message = name) => new DOMException(message, name);

class FakeFile implements FileHandleLike {
  readonly kind = "file" as const;
  bytes = new Uint8Array(0);
  lastModified = 1_700_000_000_000;
  constructor(
    readonly name: string,
    private readonly fs: FakeFs,
    readonly path: string,
  ) {}

  async getFile(): Promise<FileLike> {
    this.fs.check();
    const bytes = this.bytes.slice();
    return {
      size: bytes.length,
      lastModified: this.lastModified,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  }

  async createWritable(): Promise<WritableLike> {
    this.fs.check();
    if (this.fs.locked.has(this.path)) throw domError("NoModificationAllowedError");
    const chunks: Uint8Array[] = [];
    let done = false;
    return {
      write: async (data) => {
        if (done) throw domError("InvalidStateError");
        chunks.push(typeof data === "string" ? new TextEncoder().encode(data) : data.slice());
      },
      close: async () => {
        if (done) throw domError("InvalidStateError");
        done = true;
        if (this.fs.failingClose.delete(this.path)) throw domError("AbortError", "書き込みの途中で失敗しました");
        const size = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.length;
        }
        this.bytes = out;
        this.lastModified += 1_000;
        this.fs.writes.push(this.path);
      },
      abort: async () => {
        done = true;
      },
    };
  }
}

class FakeDir implements DirHandleLike {
  readonly kind = "directory" as const;
  readonly children = new Map<string, Node>();
  constructor(
    readonly name: string,
    private readonly fs: FakeFs,
    readonly path: string,
  ) {}

  private child(name: string): string {
    if (!name || name === "." || name === ".." || /[\\/]/.test(name)) throw new TypeError(`名前が不正です: ${name}`);
    return this.path ? `${this.path}/${name}` : name;
  }

  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<DirHandleLike> {
    this.fs.check();
    const path = this.child(name);
    const found = this.children.get(name);
    if (found) {
      if (found.kind !== "directory") throw domError("TypeMismatchError");
      return found;
    }
    if (!options.create) throw domError("NotFoundError");
    const dir = new FakeDir(name, this.fs, path);
    this.children.set(name, dir);
    return dir;
  }

  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<FileHandleLike> {
    this.fs.check();
    const path = this.child(name);
    const found = this.children.get(name);
    if (found) {
      if (found.kind !== "file") throw domError("TypeMismatchError");
      return found;
    }
    if (!options.create) throw domError("NotFoundError");
    const file = new FakeFile(name, this.fs, path);
    this.children.set(name, file);
    return file;
  }

  async removeEntry(name: string, options: { recursive?: boolean } = {}): Promise<void> {
    this.fs.check();
    const path = this.child(name);
    const found = this.children.get(name);
    if (!found) throw domError("NotFoundError");
    if (found.kind === "directory" && found.children.size > 0 && !options.recursive) {
      throw domError("InvalidModificationError");
    }
    if (found.kind === "file" && this.fs.locked.has(path)) throw domError("NoModificationAllowedError");
    this.children.delete(name);
  }

  async *entries(): AsyncIterableIterator<[string, DirHandleLike | FileHandleLike]> {
    this.fs.check();
    for (const [name, node] of [...this.children]) yield [name, node];
  }
}

export class FakeFs {
  readonly root: FakeDir;
  readonly locked = new Set<string>();
  readonly failingClose = new Set<string>();
  /** close まで済んだ書き込みの順番（パス） */
  readonly writes: string[] = [];
  private gone = false;
  private denied = false;

  constructor(name = "顛末書") {
    this.root = new FakeDir(name, this, "");
  }

  check(): void {
    if (this.gone) throw domError("NotFoundError");
    if (this.denied) throw domError("NotAllowedError");
  }

  lock(path: string): void {
    this.locked.add(path);
  }
  failClose(path: string): void {
    this.failingClose.add(path);
  }
  vanish(): void {
    this.gone = true;
  }
  deny(): void {
    this.denied = true;
  }

  /** 検証用: パスの中身を直接置く */
  put(path: string, data: Uint8Array | string): void {
    const parts = path.split("/");
    let dir = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = dir.children.get(parts[i]);
      if (!next) {
        next = new FakeDir(parts[i], this, parts.slice(0, i + 1).join("/"));
        dir.children.set(parts[i], next);
      }
      if (next.kind !== "directory") throw new Error(`${parts[i]} はファイルです`);
      dir = next;
    }
    const name = parts[parts.length - 1];
    const file = new FakeFile(name, this, path);
    file.bytes = typeof data === "string" ? new TextEncoder().encode(data) : data.slice();
    dir.children.set(name, file);
  }

  /** 検証用: パスの中身を直接読む。無ければ null */
  get(path: string): Uint8Array | null {
    const node = this.find(path);
    return node?.kind === "file" ? node.bytes : null;
  }

  text(path: string): string | null {
    const bytes = this.get(path);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  /** 検証用: いまあるファイルのパスを全部（名前順） */
  files(): string[] {
    const out: string[] = [];
    const walk = (dir: FakeDir) => {
      for (const node of dir.children.values()) {
        if (node.kind === "file") out.push(node.path);
        else walk(node);
      }
    };
    walk(this.root);
    return out.sort();
  }

  private find(path: string): Node | null {
    let node: Node = this.root;
    for (const part of path.split("/")) {
      if (node.kind !== "directory") return null;
      const next: Node | undefined = node.children.get(part);
      if (!next) return null;
      node = next;
    }
    return node;
  }
}
