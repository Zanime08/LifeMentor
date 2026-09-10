/**
 * User-facing error copy (phase 20 polish, req. 95/86).
 *
 * The core engine throws precise internal messages (English, developer-grade).
 * Showing those raw to the user ("Insert into goals did not return a row") is a
 * leak of internals, not an explanation. `userError` maps the known cases to
 * short, honest Russian sentences; anything unknown gets a safe generic.
 * The original message stays in the console (toastError logs it) for support.
 */
export function userError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e ?? 'unknown error');

  // App not ready (driver closed / bootstrap race) — retrying usually helps.
  if (/database is not open|WasmSqlDriver: not open|not open/i.test(msg)) {
    return 'Приложение ещё не готово — попробуйте ещё раз.';
  }
  // Write did not land.
  if (/did not return a row|failed to (insert|update|delete)|SQLITE_CONSTRAINT|constraint/i.test(msg)) {
    return 'Не удалось сохранить изменение. Попробуйте ещё раз.';
  }
  // Bad input reached the engine.
  if (/invalid date|invalid identifier|unsafe (column|identifier)/i.test(msg)) {
    return 'Не удалось обработать данные. Попробуйте ещё раз.';
  }
  // Backup/restore.
  if (/backup not found/i.test(msg)) return 'Резервная копия не найдена.';
  if (/snapshot is too small|restore/i.test(msg)) return 'Восстановление не удалось — снимок повреждён.';
  // AI layer.
  if (/could not produce valid structured output|unknown sql driver/i.test(msg)) {
    return 'Не удалось сформировать ответ. Попробуйте переформулировать запрос.';
  }
  // Platform shell missing (should not happen in a packaged build).
  if (/runtime is not available|plugin is not available/i.test(msg)) {
    return 'Платформа недоступна — перезапустите приложение.';
  }
  // A screen chunk that could not be fetched (screens are lazy): the browser's wording, and the
  // Capacitor/Tauri equivalents. Checked before the generic network rule, because «Сервер
  // недоступен, синхронизация догонит позже» is the wrong sentence for "this screen did not load".
  if (/dynamically imported module|importing a module script failed|loading chunk \w+ failed|error loading dynamically/i.test(msg)) {
    return 'Не удалось загрузить этот экран. Проверьте подключение и попробуйте ещё раз.';
  }
  // Network (server calls that the user triggered directly).
  if (/failed to fetch|network|fetch failed|econnrefused|timed? ?out|HTTP (5\d\d|000)/i.test(msg)) {
    return 'Сервер недоступен. Данные сохранены локально — синхронизация догонит позже.';
  }
  return 'Что-то пошло не так. Попробуйте ещё раз.';
}
