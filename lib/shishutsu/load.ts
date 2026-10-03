/**
 * 選んだ表（xlsx）のバイト列を、シートの表にする。パスワード付きなら、渡されたパスワードで開く。
 * ★パスワードはどこにも残さない（この関数の中で使うだけ）。
 */
import { type SheetTable, readXlsxSheets } from "@/lib/after/xlsx-read";
import { WrongPasswordError, decryptXlsx, isEncryptedOffice } from "@/lib/xlsx/decrypt";

/** パスワード付きの表なのに、パスワードが入っていない */
export class PasswordNeededError extends Error {
  constructor(readonly label: string) {
    super(`${label}はパスワード付きです。パスワードを入れてください`);
    this.name = "PasswordNeededError";
  }
}

export async function openSheets(bytes: Uint8Array, password: string, label: string): Promise<SheetTable[]> {
  let plain = bytes;
  if (isEncryptedOffice(bytes)) {
    if (!password) throw new PasswordNeededError(label);
    try {
      plain = await decryptXlsx(bytes, password);
    } catch (e) {
      if (e instanceof WrongPasswordError) throw new Error(`${label}のパスワードが違います`);
      throw e;
    }
  }
  return readXlsxSheets(plain);
}
