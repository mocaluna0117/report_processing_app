/**
 * 使用する Gemini モデル名 (サーバー側のみ参照)。
 * モデルの提供終了時に「This model ... is no longer available」エラーが出たら、
 * コードを変えずに .env.local の GEMINI_MODEL で切り替えられる。
 */
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
