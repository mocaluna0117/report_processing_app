"use client";

/**
 * 誰がログインしているか（表示用の印 folio_signed_in を読む）。★認証には使わない（表示にだけ使う）。
 * 読むのはマウント後（サーバー側の描画と食い違わないように）。画面を移るたびに読み直す
 * （パスワードを決めた直後など、印が変わるため）。
 */
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { SIGNED_IN_COOKIE, type SignedInMarker, readSignedInMarker } from "@/lib/auth";

export function readSignedInCookie(): SignedInMarker | null {
  if (typeof document === "undefined") return null;
  const raw = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${SIGNED_IN_COOKIE}=`))
    ?.slice(SIGNED_IN_COOKIE.length + 1);
  let value = raw;
  try {
    value = raw === undefined ? undefined : decodeURIComponent(raw);
  } catch {
    // 読めなければそのまま
  }
  return readSignedInMarker(value);
}

export function useSignedIn(): SignedInMarker | null {
  const pathname = usePathname();
  const [signedIn, setSignedIn] = useState<SignedInMarker | null>(null);
  useEffect(() => {
    setSignedIn(readSignedInCookie());
  }, [pathname]);
  return signedIn;
}
