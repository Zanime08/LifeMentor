import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FieldDiff, LifeMentorApp, RecoveryReport, SyncConflict } from '@lifementor/core';
import { Btn, Card, Confirm, Field, I, Modal, PageHead, Select, Spinner, Tag, TextInput } from '../components/ui';
import { useApp } from '../state/store';
import { SERVER_URL_STORAGE_KEY } from '../core/app';
import { disablePush, enablePush, getPushState, sendTestPush } from '../push';
import { cloudBackupStatus, deleteCloudBackup, downloadCloudBackup, uploadCloudBackup, type CloudBackupStatus } from '../cloud-backup';
import { timeAgo } from '../lib/ru';

type Health = Awaited<ReturnType<LifeMentorApp['health']>>;

export function Settings() {
  const { app, version, mutate, toast, toastError, auth, syncStatus, refresh } = useApp();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'sync' | 'data' | 'planning' | 'notifications' | 'ai' | 'privacy' | 'diagnostics'>('sync');

  return (
    <div className="content narrow" style={{ padding: 0 }}>
      <PageHead title="Настройки" />
      <div className="row wrap mb" style={{ gap: 6 }}>
        {([
          ['sync', 'Аккаунт и синхронизация'], ['data', 'Данные и резервные копии'],
          ['planning', 'Планирование'], ['notifications', 'Уведомления'],
          ['ai', 'ИИ и память'], ['privacy', 'Приватность'], ['diagnostics', 'Диагностика'],
        ] as const).map(([id, label]) => (
          <button key={id} type="button" className={`q-option ${tab === id ? 'sel' : ''}`} style={{ margin: 0, padding: '7px 12px', fontSize: 12.5 }} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {!app ? <Spinner /> : (
        <>
          {tab === 'sync' && <SyncTab />}
          {tab === 'data' && <DataTab />}
          {tab === 'planning' && <PlanningTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'ai' && <AiTab />}
          {tab === 'privacy' && <PrivacyTab />}
          {tab === 'diagnostics' && <DiagnosticsTab />}
        </>
      )}
      <div style={{ height: 20 }} />
    </div>
  );
}

/* ── account & sync ─────────────────────────────────────────────────── */
function SyncTab() {
  const { app, mutate, toast, toastError, auth, syncStatus, version, refresh } = useApp();
  const navigate = useNavigate();
  const [conflicts, setConflicts] = useState<(SyncConflict & { local: Record<string, unknown>; remote: Record<string, unknown>; diff: FieldDiff[] })[]>([]);
  const [resolveFor, setResolveFor] = useState<(typeof conflicts)[number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverDraft, setServerDraft] = useState<string>(() => (typeof localStorage !== 'undefined' ? localStorage.getItem(SERVER_URL_STORAGE_KEY) ?? '' : ''));

  useEffect(() => {
    if (!app?.services.sync) return;
    let stop = false;
    app.services.sync.openConflicts().then((c) => { if (!stop) setConflicts(c); }).catch(() => undefined);
    return () => { stop = true; };
  }, [app, version]);

  const syncNow = async () => {
    if (!app?.services.sync) return;
    setBusy(true);
    try {
      const report = await app.services.sync.syncOnce();
      toast(`Синхронизация: отправлено ${report.pushed}, получено ${report.pulled}, конфликтов ${report.conflictsCreated}.`, 'ok');
      refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Card title="Аккаунт">
        {auth?.authenticated ? (
          <div className="kv">
            <dt>Email</dt><dd>{auth.email}</dd>
            <dt>Имя</dt><dd>{auth.displayName ?? '—'}</dd>
            <dt>Сессия</dt><dd>{auth.expiresInMinutes != null ? `действительна ещё ~${auth.expiresInMinutes} мин` : 'активна'}</dd>
          </div>
        ) : (
          <div className="small muted">
            Без аккаунта приложение полностью работает офлайн: база, планировщик, наставник-движок.
            Аккаунт включает синхронизацию между устройствами и облачный ИИ.
          </div>
        )}
        <div className="row mt">
          {!auth?.authenticated
            ? <Btn kind="primary" size="sm" onClick={() => navigate('/auth')}>Войти / зарегистрироваться</Btn>
            : <Btn size="sm" kind="danger" onClick={() => void mutate(() => app!.services.auth.signOut(), 'Вы вышли. Локальные данные сохранены.')}>Выйти</Btn>}
        </div>
      </Card>

      <Card title="Синхронизация" sub="Локальная база — источник истины. Синхронизация инкрементальная, по версиям сущностей."
        action={syncStatus ? <Tag tone={syncStatus.pending > 0 ? 'p1' : 'green'}>{syncStatus.pending} в очереди</Tag> : undefined}>
        <div className="field mb-sm">
          <label>Сервер LifeMentor (https://…)</label>
          <div className="row wrap" style={{ gap: 8 }}>
            <TextInput
              placeholder="Оставьте пустым для этого устройства (превью / локально)"
              value={serverDraft}
              onChange={(e) => setServerDraft(e.target.value)}
              style={{ flex: 1, minWidth: 220 }}
            />
            <Btn size="sm" kind="primary" onClick={() => {
              const v = serverDraft.trim().replace(/\/+$/, '');
              try {
                if (v) localStorage.setItem(SERVER_URL_STORAGE_KEY, v);
                else localStorage.removeItem(SERVER_URL_STORAGE_KEY);
              } catch { /* ignore */ }
              window.location.reload();
            }}>{serverDraft.trim() ? 'Сохранить и перезапустить' : 'Сбросить адрес'}</Btn>
          </div>
          <p className="xsmall muted" style={{ marginTop: 4 }}>
            Адрес сервера, где хранятся ваш аккаунт, синхронизация, новости и облачный ИИ.
            Ключи ИИ остаются только на сервере. Изменение применяется после перезапуска.
          </p>
        </div>
        {!auth?.authenticated && <div className="small muted mb-sm">Войдите в аккаунт, чтобы включить синхронизацию.</div>}
        {auth?.authenticated && (
          <>
            <div className="kv mb-sm">
              <dt>Сервер</dt><dd>{syncStatus?.serverUrl ?? '—'}</dd>
              <dt>Очередь</dt><dd>{syncStatus?.pending ?? 0} операций</dd>
              <dt>Конфликты</dt><dd>{syncStatus?.conflictsOpen ?? 0}</dd>
              <dt>Последний push</dt><dd>{syncStatus?.lastPushedAt ? timeAgo(syncStatus.lastPushedAt) : 'ещё не было'}</dd>
              {syncStatus?.lastError && <><dt>Последняя ошибка</dt><dd style={{ color: 'var(--danger)' }}>{syncStatus.lastError}</dd></>}
            </div>
            <div className="row">
              <Btn kind="primary" size="sm" onClick={() => void syncNow()} disabled={busy}>{busy ? 'Синхронизирую…' : 'Синхронизировать сейчас'}</Btn>
            </div>
          </>
        )}
        {conflicts.length > 0 && (
          <>
            <div className="section-title">Конфликты (требуют вашего решения)</div>
            {conflicts.map((c) => (
              <div key={c.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div className="li-main">
                  <div className="li-title">{c.entity_type} · поле {c.field ?? '—'}</div>
                  <div className="li-sub">обнаружен {timeAgo(c.detected_at)} · локальная версия {c.base_version} ↔ сервер {c.server_version}</div>
                </div>
                <Btn size="xs" onClick={() => setResolveFor(c)}>Решить</Btn>
              </div>
            ))}
          </>
        )}
      </Card>

      {resolveFor && (
        <Modal title="Конфликт версий" onClose={() => setResolveFor(null)} wide>
          <p className="small muted mb-sm">
            «Эта запись была изменена на двух устройствах. Какую версию оставить?»
            Поля, изменившиеся в одном месте только, уже слиты автоматически; ниже — совпадающие.
          </p>
          {resolveFor.diff.map((d) => (
            <div key={d.field} className="row" style={{ gap: 10, padding: '6px 0', alignItems: 'flex-start' }}>
              <span className="small muted" style={{ width: 120 }}>{d.field}</span>
              <span className="small grow" style={{ fontWeight: 600 }}>{JSON.stringify(d.local)}</span>
              <span className="small grow" style={{ color: 'var(--info)', fontWeight: 600 }}>{JSON.stringify(d.remote)}</span>
            </div>
          ))}
          <div className="row mt" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <Btn size="sm" onClick={() => void resolve(resolveFor.id, 'local')}>Оставить мою</Btn>
            <Btn size="sm" onClick={() => void resolve(resolveFor.id, 'remote')}>Взять с сервера</Btn>
            <Btn size="sm" kind="primary" onClick={() => void resolve(resolveFor.id, 'merged')}>Слить (оба изменения)</Btn>
          </div>
        </Modal>
      )}
    </div>
  );

  async function resolve(id: string, choice: 'local' | 'remote' | 'merged') {
    if (!app?.services.sync) return;
    try {
      await app.services.sync.resolveConflict(id, choice);
      toast('Конфликт разрешён. Оба устройства получат итоговую версию.', 'ok');
      setResolveFor(null);
      refresh();
    } catch (e) {
      toastError(e);
    }
  }
}

/* ── data & backups ─────────────────────────────────────────────────── */
function DataTab() {
  const { app, mutate, toast, toastError, hardReset, auth } = useApp();
  const [backups, setBackups] = useState<Awaited<ReturnType<import('@lifementor/core').BackupService['list']>>>([]);
  const [importPreview, setImportPreview] = useState<{ name: string; data: string } | null>(null);
  const [exportFirst, setExportFirst] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [cloud, setCloud] = useState<CloudBackupStatus | null>(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadBackups = () => { if (app) void app.services.backup.list().then(setBackups).catch(() => undefined); };
  useEffect(loadBackups, [app]);

  // Cloud backup status (metadata only — the ciphertext never touches the UI).
  const loadCloud = useCallback(() => {
    if (!app || !auth?.authenticated) { setCloud({ exists: false }); return; }
    void cloudBackupStatus(app).then(setCloud).catch(() => setCloud(null));
  }, [app, auth?.authenticated]);
  useEffect(loadCloud, [loadCloud]);

  const runCloud = async (fn: () => Promise<void>) => {
    setCloudBusy(true);
    try { await fn(); loadCloud(); } finally { setCloudBusy(false); }
  };

  const doExport = async () => {
    if (!app) return;
    try {
      const archive = await app.services.backup.exportArchive({ includeNews: true });
      const json = JSON.stringify(archive, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lifementor-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('Экспорт создан: переносимый JSON-архив всех ваших данных.', 'ok');
    } catch (e) {
      toastError(e);
    }
  };

  const onImportFile = async (file: File) => {
    try {
      const text = await file.text();
      setImportPreview({ name: file.name, data: text });
    } catch (e) {
      toastError(e);
    }
  };

  const applyImport = async (mode: 'merge' | 'replace') => {
    if (!app || !importPreview) return;
    try {
      await app.services.backup.createBackup('auto', 'pre-import safety copy');
      const archive = await app.services.backup.parseArchive(importPreview.data);
      const report = await app.services.backup.importArchive(archive, mode);
      toast(`Импорт завершён (режим: ${report.mode}): +${report.totals.create} создано, ${report.totals.update} обновлено, ${report.totals.skip} пропущено. Предыдущее состояние сохранено в резервной копии.`, 'ok');
      setImportPreview(null);
      window.location.reload();
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="stack">
      <Card title="Резервные копии" sub="Автоматически: при первом запуске и ежедневно. Хранятся локально (в браузере — OPFS/IndexedDB).">
        <div className="row mb-sm">
          <Btn kind="primary" size="sm" onClick={() => void mutate(() => app!.services.backup.createBackup('manual'), 'Резервная копия создана').then(() => loadBackups())}>Создать копию</Btn>
        </div>
        {backups.map((b) => (
          <div key={b.id} className="row" style={{ gap: 10, padding: '6px 0', alignItems: 'center' }}>
            <div className="grow">
              <div className="small" style={{ fontWeight: 600 }}>{b.kind}{b.note ? ` · ${b.note}` : ''}</div>
              <div className="xsmall muted">{timeAgo(b.created_at)} · {b.size_bytes != null ? `${(b.size_bytes / 1024).toFixed(0)} КБ` : ''}</div>
            </div>
            <Btn size="xs" onClick={() => void mutate(() => app!.services.backup.verify(b.id)).then((r) => {
              if (r) toast(r.ok ? `Копия целостна (${r.size_bytes} Б).` : `Проблема: ${r.reason}`, r.ok ? 'ok' : 'error');
            })}>Проверить</Btn>
            <Btn size="xs" kind="danger" onClick={() => void mutate(() => app!.services.backup.restore(b.id), 'Восстановлено из копии — перезагружаю').then(() => window.location.reload())}>Восстановить</Btn>
          </div>
        ))}
      </Card>

      <Card title="Экспорт и импорт" sub="JSON — переносимый формат: профиль, цели, навыки, проекты, задачи, календарь, память, прогресс.">
        <div className="row wrap">
          <Btn size="sm" onClick={() => void doExport()}>{I.download} Export my data</Btn>
          <Btn size="sm" onClick={() => fileRef.current?.click()}>{I.upload} Импорт из архива</Btn>
          <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportFile(f); e.target.value = ''; }} />
        </div>
        {importPreview && (
          <div className="proactive mt">
            <b>Файл: {importPreview.name}</b>
            <div className="small mt-sm">Перед импортом: структура и версия проверены, текущее состояние — в резервной копии. Выберите режим:</div>
            <div className="row mt-sm">
              <Btn size="sm" kind="primary" onClick={() => void applyImport('merge')}>Слить с текущим</Btn>
              <Btn size="sm" kind="danger" onClick={() => void applyImport('replace')}>Заменить всё</Btn>
              <Btn size="sm" kind="ghost" onClick={() => setImportPreview(null)}>Отмена</Btn>
            </div>
          </div>
        )}
      </Card>

      <Card title="Облачная копия" sub="Шифруется на устройстве (AES-GCM). Сервер хранит только шифртекст, который не может прочитать — плюс контрольную сумму для проверки целостности.">
        <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
          {cloud === null && <span className="xsmall muted">не удалось получить статус сервера</span>}
          {cloud?.exists && (
            <span className="xsmall muted">
              на сервере: {(cloud.size_bytes ?? 0) / 1024 / 1024 >= 1
                ? `${((cloud.size_bytes ?? 0) / 1024 / 1024).toFixed(1)} МБ`
                : `${Math.max(1, Math.round((cloud.size_bytes ?? 0) / 1024))} КБ`}
              {' · '}создана {cloud.created_at ? new Date(cloud.created_at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
              {cloud.checksum ? ` · sha256 ${cloud.checksum.slice(0, 12)}…` : ''}
            </span>
          )}
          {cloud && !cloud.exists && <span className="xsmall muted">облачной копии пока нет</span>}
          <div style={{ flex: 1 }} />
          <Btn size="sm" disabled={cloudBusy || !auth?.authenticated} onClick={() => void runCloud(async () => {
            const meta = await uploadCloudBackup(app!);
            toast(`Облачная копия загружена (${Math.max(1, Math.round(meta.size_bytes! / 1024))} КБ, шифртекст).`, 'ok');
          })}>{I.cloud} Загрузить копию</Btn>
          <Btn size="sm" disabled={cloudBusy || !cloud?.exists} onClick={() => void runCloud(async () => {
            const { archive } = await downloadCloudBackup(app!);
            setImportPreview({ name: 'облачная копия (расшифрована)', data: JSON.stringify(archive) });
            toast('Копия расшифрована и проверена. Выберите режим импорта ниже.', 'ok');
          })}>Скачать и импортировать</Btn>
          <Btn size="sm" kind="danger" disabled={cloudBusy || !cloud?.exists} onClick={() => void runCloud(async () => {
            await deleteCloudBackup(app!);
            toast('Облачная копия удалена с сервера.', 'warn');
          })}>Удалить с сервера</Btn>
        </div>
        <p className="xsmall muted" style={{ marginTop: 8 }}>
          Ключ шифрования хранится в этом браузере (в десктопной/мобильной сборке — в хранилище ОС).
          Если хранилище будет очищено, облачная копия станет невосстановимой — локальные копии и экспорт
          работают независимо.
        </p>
      </Card>

      <Card title="Удаление аккаунта и данных" sub="Безвозвратно. Перед удалением можно создать экспорт."
        className="danger-zone">
        <div className="row wrap" style={{ gap: 10 }}>
          <label className="checkbox"><input type="checkbox" checked={exportFirst} onChange={(e) => setExportFirst(e.target.checked)} /> Сделать экспорт перед удалением</label>
        </div>
        <div className="row mt">
          <Btn size="sm" kind="danger" onClick={() => setDeleting(true)}>{I.trash} Удалить аккаунт и все данные</Btn>
        </div>
      </Card>

      {deleting && (
        <Confirm title="Удалить аккаунт и все данные?"
          text={`Это удалит:\n• все локальные данные (цели, задачи, память, историю);\n• данные на сервере, если есть аккаунт;\n• сессию и токены.\n\n${exportFirst ? 'Сначала будет создан файл экспорта.' : 'Экспорт не будет создаваться — убедитесь, что он вам не нужен.'}\nДействие нельзя отменить.`}
          confirmLabel="Удалить навсегда"
          onConfirm={() => {
            void (async () => {
              try {
                if (app) {
                  const result = await app.services.auth.deleteAccount({ exportFirst });
                  toast(result.receipt
                    ? 'Аккаунт удалён на сервере, локальные данные стёрты. Экспорт сохранён в резервных копиях.'
                    : 'Локальные данные стёрты, аккаунт удалён (или не был создан).', 'warn');
                }
                await hardReset();
              } catch (e) {
                toastError(e);
              }
            })();
          }}
          onClose={() => setDeleting(false)} />
      )}
    </div>
  );
}

/* ── planning ───────────────────────────────────────────────────────── */
function PlanningTab() {
  const { app, mutate } = useApp();
  const [s, setS] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { if (app) void app.services.settings.get('planning').then((p) => setS(p as never)).catch(() => undefined); }, [app]);
  if (!s) return <Spinner />;
  const set = (key: string, value: unknown) => {
    setS((m) => ({ ...m!, [key]: value }));
    void mutate(() => app!.services.settings.set('planning', { [key]: value } as never));
  };
  return (
    <Card title="Планировщик" sub="Определяет, сколько план реально может влезть в ваш день.">
      <div className="field">
        <label>Стройность плана</label>
        <div className="row wrap" style={{ gap: 6 }}>
          {(['strict', 'balanced', 'flexible'] as const).map((v) => (
            <button key={v} type="button" className={`q-option ${s.style === v ? 'sel' : ''}`} style={{ margin: 0 }} onClick={() => set('style', v)}>
              {v === 'strict' ? 'Строгий — спрашивает причину при пропуске' : v === 'balanced' ? 'Сбалансированный' : 'Гибкий — только предложения'}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Настойчивость наставника: {String(s.strictness)}</label>
        <input type="range" min={0} max={1} step={0.1} value={Number(s.strictness)} onChange={(e) => set('strictness', Number(e.target.value))} style={{ width: '100%', accentColor: 'var(--accent)' }} />
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Свободное время в день (мин)"><TextInput type="number" min={0} max={480} step={15} value={String(s.free_time_minutes)} onChange={(e) => set('free_time_minutes', Number(e.target.value) || 0)} style={{ width: 110 }} /></Field>
        <Field label="Подъём"><TextInput type="time" value={String(s.wake_time)} onChange={(e) => set('wake_time', e.target.value)} style={{ width: 110 }} /></Field>
        <Field label="Отбой"><TextInput type="time" value={String(s.sleep_time)} onChange={(e) => set('sleep_time', e.target.value)} style={{ width: 110 }} /></Field>
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Рабочий день: с"><TextInput type="time" value={String(s.work_start)} onChange={(e) => set('work_start', e.target.value)} style={{ width: 110 }} /></Field>
        <Field label="по"><TextInput type="time" value={String(s.work_end)} onChange={(e) => set('work_end', e.target.value)} style={{ width: 110 }} /></Field>
        <Field label="Максимум фокуса (ч)"><TextInput type="number" min={0.5} max={12} step={0.5} value={String(s.max_focus_hours_per_day)} onChange={(e) => set('max_focus_hours_per_day', Number(e.target.value) || 5)} style={{ width: 110 }} /></Field>
        <Field label="Пауза каждые (мин)"><TextInput type="number" min={20} max={180} step={10} value={String(s.break_every_minutes)} onChange={(e) => set('break_every_minutes', Number(e.target.value) || 90)} style={{ width: 110 }} /></Field>
      </div>
      <p className="xsmall muted mt-sm">
        Планировщик никогда не ставит обучение поверх жёстких событий и не создаёт нереалистичных расписаний:
        если 8 часов колледжа + 2 часа дороги — 8 часов обучения добавлены не будут.
      </p>
    </Card>
  );
}

/* ── notifications ──────────────────────────────────────────────────── */
function NotificationsTab() {
  const { app, mutate } = useApp();
  const [s, setS] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { if (app) void app.services.settings.get('notifications').then((p) => setS(p as never)).catch(() => undefined); }, [app]);
  if (!s) return <Spinner />;
  const set = (key: string, value: unknown) => {
    setS((m) => ({ ...m!, [key]: value }));
    void mutate(() => app!.services.settings.set('notifications', { [key]: value } as never));
  };
  return (
    <Card title="Уведомления" sub="Умная подача: важность + срочность + время + дневной бюджет. Никакого спама (req. 86).">
      <div className="row mb-sm">
        <label className="checkbox"><input type="checkbox" checked={Boolean(s.enabled)} onChange={(e) => set('enabled', e.target.checked)} /> Уведомления включены</label>
      </div>
      <div className="row mb-sm">
        <label className="checkbox"><input type="checkbox" checked={Boolean(s.proactive_mentor)} onChange={(e) => set('proactive_mentor', e.target.checked)} /> Наставник может писать первым (по делу)</label>
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Тихие часы: с"><TextInput type="time" value={String(s.quiet_start ?? '22:30')} onChange={(e) => set('quiet_start', e.target.value)} style={{ width: 110 }} /></Field>
        <Field label="до"><TextInput type="time" value={String(s.quiet_end ?? '07:30')} onChange={(e) => set('quiet_end', e.target.value)} style={{ width: 110 }} /></Field>
        <Field label="Дневной бюджет"><TextInput type="number" min={0} max={30} value={String(s.daily_budget)} onChange={(e) => set('daily_budget', Number(e.target.value) || 6)} style={{ width: 110 }} /></Field>
      </div>
      <PushCard />
      <p className="xsmall muted">Каждое уведомление проходит фильтр: «это действительно нужно знать или сделать сейчас?»</p>
    </Card>
  );
}

/** Web Push: подписка на системные уведомления (в т.ч. при закрытой вкладке) + диагностика. */
function PushCard() {
  const { app, auth, toast } = useApp();
  const [state, setState] = useState<Awaited<ReturnType<typeof getPushState>> | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (app) setState(await getPushState(app));
  }, [app]);
  useEffect(() => { void load(); }, [load]);

  if (!state) return null;
  if (!state.supported) {
    return (
      <div className="proactive">
        <b>Push-уведомления</b> — не поддерживаются в этом браузере ({state.reason}).
        Внутри открытого приложения уведомления продолжают работать, а пока приложение закрыто —
        накопятся и придут при следующем открытии.
      </div>
    );
  }

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    setBusy(true);
    const result = await fn();
    setBusy(false);
    if (result.ok) toast(okText, 'ok');
    else toast(result.error ?? 'Не получилось включить push', 'error');
    void load();
  };

  return (
    <div className="proactive" style={{ marginTop: 10 }}>
      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <b>Push-уведомления</b>
        <Tag tone={state.permission === 'granted' && state.subscribed ? 'green' : state.permission === 'denied' ? 'red' : 'outline'}>
          {state.permission === 'granted' && state.subscribed ? 'включены' : state.permission === 'denied' ? 'заблокированы браузером' : 'выключены'}
        </Tag>
        <div style={{ flex: 1 }} />
        {state.permission === 'granted' && state.subscribed ? (
          <Btn kind="ghost" size="sm" disabled={busy} onClick={() => void run(() => disablePush(app!), 'Push отключён')}>Отключить</Btn>
        ) : state.permission !== 'denied' ? (
          <Btn kind="primary" size="sm" disabled={busy || !app || !auth?.authenticated} onClick={() => void run(() => enablePush(app!), 'Push включён — проверьте системные уведомления')}>Включить push</Btn>
        ) : null}
        {state.permission === 'granted' && state.subscribed && (
          <Btn kind="ghost" size="sm" disabled={busy || !app} onClick={() => void (async () => {
            const result = await sendTestPush(app!);
            if (result.ok && result.push === 'sent') toast('Тестовое уведомление отправлено', 'ok');
            else if (result.ok && result.push === 'skipped') toast('Нет активных подписок — сначала включите push', 'warn');
            else toast(result.error ?? 'Сервер не смог доставить уведомление', 'error');
          })()}>Тест</Btn>
        )}
        {!auth?.authenticated && <span className="xsmall muted">нужен вход в аккаунт</span>}
      </div>
      <p className="xsmall muted" style={{ marginTop: 6 }}>
        Работает, даже когда вкладка закрыта (Service Worker). Если push не дошёл — накопленное придёт
        при следующем открытии приложения. Ключи подписки хранит сервер, а каждое уведомление всё равно
        проходит ваш дневной бюджет и тихие часы.
      </p>
    </div>
  );
}

/* ── AI ─────────────────────────────────────────────────────────────── */
function AiTab() {
  const { app, mutate } = useApp();
  const [s, setS] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { if (app) void app.services.settings.get('ai').then((p) => setS(p as never)).catch(() => undefined); }, [app]);
  if (!s) return <Spinner />;
  const set = (key: string, value: unknown) => {
    setS((m) => ({ ...m!, [key]: value }));
    void mutate(() => app!.services.settings.set('ai', { [key]: value } as never));
  };
  return (
    <Card title="ИИ и память" sub="Ключи провайдеров хранятся только на сервере. Офлайн — встроенный детерминированный движок.">
      <div className="row mb-sm">
        <label className="checkbox"><input type="checkbox" checked={Boolean(s.memory_enabled)} onChange={(e) => set('memory_enabled', e.target.checked)} /> Долгосрочная память ИИ</label>
      </div>
      <div className="field">
        <label>Провайдер</label>
        <div className="row wrap" style={{ gap: 6 }}>
          {(['auto', 'local'] as const).map((v) => (
            <button key={v} type="button" className={`q-option ${s.provider_preference === v ? 'sel' : ''}`} style={{ margin: 0 }} onClick={() => set('provider_preference', v)}>
              {v === 'auto' ? 'Автоматически (серверный, если доступен)' : 'Только локальный офлайн-движок'}
            </button>
          ))}
        </div>
      </div>
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Язык ИИ">
          <Select value={String(s.language)} onChange={(e) => set('language', e.target.value)} style={{ width: 120 }}>
            <option value="ru">русский</option><option value="en">english</option>
          </Select>
        </Field>
      </div>
      <div className="proactive mt">
        <b>Как это устроено:</b> контекст формируется динамически (только релевантное: профиль, цели, план дня,
        активные задачи, релевантная память) и отправляется на сервер. Инструменты (создать задачу, перенести, запомнить)
        выполняются локально в вашей базе — у модели нет прямого доступа к данным (req. 24, 25).
      </div>
    </Card>
  );
}

/* ── privacy ────────────────────────────────────────────────────────── */
function PrivacyTab() {
  const { app, mutate } = useApp();
  const [s, setS] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { if (app) void app.services.settings.get('privacy').then((p) => setS(p as never)).catch(() => undefined); }, [app]);
  if (!s) return <Spinner />;
  const set = (key: string, value: unknown) => {
    setS((m) => ({ ...m!, [key]: value }));
    void mutate(() => app!.services.settings.set('privacy', { [key]: value } as never));
  };
  return (
    <Card title="Приватность">
      <div className="row mb-sm">
        <label className="checkbox"><input type="checkbox" checked={Boolean(s.analytics)} onChange={(e) => set('analytics', e.target.checked)} /> Локальная аналитика поведения (только на устройстве)</label>
      </div>
      <Field label="Хранение памяти ИИ (дней, пусто = навсегда)">
        <TextInput type="number" min={30} max={3650} placeholder="∞" value={s.memory_retention_days == null ? '' : String(s.memory_retention_days)}
          onChange={(e) => set('memory_retention_days', e.target.value === '' ? null : Number(e.target.value))} style={{ width: 140 }} />
      </Field>
      <p className="xsmall muted mt-sm">
        Полный контроль: просмотр памяти («Профиль»), удаление отдельных фактов, экспорт всего, удаление аккаунта — в «Данные».
      </p>
    </Card>
  );
}

/* ── diagnostics ────────────────────────────────────────────────────── */
const SEVERITY_RU: Record<string, string> = { info: 'к сведению', warning: 'внимание', critical: 'критично' };

/**
 * Russian wording for a recovery issue (req. 13). Built from the kind and the data; the engine's own
 * `message` is an internal English string ("3 orphan row(s) were removed…").
 */
function recoveryIssueText(issue: RecoveryReport['issues'][number]): string | null {
  const data = (issue.data ?? {}) as Record<string, unknown>;
  const count = Number((data.taskIds as unknown[] | undefined)?.length ?? data.count ?? 0) || 0;
  switch (issue.kind) {
    case 'integrity':
      return 'Проверка целостности базы нашла проблемы. Копия повреждённых строк сохранена в журнале изменений.';
    case 'orphan':
      return 'Найдены строки без владельца (осиротевшие связи). Они убраны из базы, их содержимое сохранено в журнале изменений.';
    case 'schema':
      return 'Версия схемы базы не совпадает с версией приложения. Обновите приложение или восстановите копию.';
    case 'stale_task':
      return count > 0
        ? `${count} ${count === 1 ? 'задача осталась' : 'задач осталось'} в работе с прошлого запуска — отметьте, выполнены ли они.`
        : 'Остались задачи в работе с прошлого запуска — отметьте, выполнены ли они.';
    case 'sync':
      return 'Часть изменений синхронизации ждёт отправки. Проверьте состояние в разделе «Аккаунт и синхронизация».';
    case 'snapshot':
      return 'Не удалось создать снепшот дня — он появится при следующем запуске.';
    default:
      return null;
  }
}

/**
 * The startup recovery sequence (req. 13) used to vanish into the console: the engine repaired what
 * it could, reported leftovers — «these tasks were still in progress when the app closed, did you
 * finish them?» — and the user never saw any of it. This shows the report and can re-run it.
 */
function RecoveryCard() {
  const { app, toast, toastError, refresh } = useApp();
  const [report, setReport] = useState<RecoveryReport | null>(app?.recoveryReport ?? null);
  const [running, setRunning] = useState(false);
  const run = async () => {
    if (!app || running) return;
    setRunning(true);
    try {
      const next = await app.services.recovery.startup();
      setReport(next);
      refresh();
      toast(next.ok ? 'Проверка завершена: всё в порядке' : 'Проверка завершена — есть замечания', next.ok ? 'ok' : 'warn');
    } catch (error) {
      toastError(error);
    } finally {
      setRunning(false);
    }
  };
  // The engine's `message` is English (the AI and the log read it) — the card words it from the
  // issue kind and the numbers, and drops anything it cannot word rather than printing English.
  const issueLines = report?.issues.filter((issue) => !!recoveryIssueText(issue)) ?? [];
  const tone = (status: RecoveryReport['actions'][number]['status']) =>
    status === 'ok' ? 'green' : status === 'repaired' ? 'gold' : status === 'failed' ? 'danger' : 'outline';
  const issueTone = (severity: RecoveryReport['issues'][number]['severity']) =>
    severity === 'critical' ? 'danger' : severity === 'warning' ? 'gold' : 'outline';
  return (
    <Card
      title="Восстановление после сбоя"
      action={<Btn size="xs" disabled={running} onClick={() => void run()}>{running ? 'Проверяю…' : 'Проверить сейчас'}</Btn>}
    >
      {!report ? (
        <p className="muted small">Проверка ещё не выполнялась в этой сессии.</p>
      ) : (
        <>
          <div className="kv">
            <dt>Итог</dt>
            <dd style={{ color: report.ok ? 'var(--accent)' : 'var(--danger)' }}>
              {report.ok ? 'целостность в порядке' : 'нужно ваше внимание'}
            </dd>
            <dt>Когда</dt><dd>{timeAgo(report.finishedAt)} · {report.durationMs} мс</dd>
            <dt>Последний экран</dt><dd>{report.state.lastRoute ?? '—'}</dd>
            <dt>Черновики</dt><dd>{Object.keys(report.state.drafts).length}</dd>
          </div>
          <div className="section-title">Шаги проверки</div>
          {report.actions.map((a, i) => (
            <div className="row wrap" key={`${a.step}-${i}`} style={{ gap: 8, padding: '2px 0' }}>
              <Tag tone={tone(a.status)}>{a.status}</Tag>
              <span className="small">{a.step}</span>
              <span className="xsmall muted grow">{a.detail}</span>
            </div>
          ))}
          {issueLines.length > 0 && (
            <>
              <div className="section-title">Что требует внимания</div>
              {issueLines.map((issue, i) => (
                <div className="row wrap" key={`issue-${i}`} style={{ gap: 8, padding: '3px 0' }}>
                  <Tag tone={issueTone(issue.severity)}>{SEVERITY_RU[issue.severity]}</Tag>
                  <span className="small grow">{recoveryIssueText(issue)}</span>
                </div>
              ))}
            </>
          )}
          {report.state.onboarding && (
            <p className="muted xsmall mt-sm">Знакомство осталось на шаге: {report.state.onboarding}</p>
          )}
        </>
      )}
    </Card>
  );
}

function DiagnosticsTab() {
  const { app } = useApp();
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => { if (app) void app.health().then(setHealth).catch(() => undefined); }, [app]);
  if (!health) return <Spinner />;
  return (
    <>
    <RecoveryCard />
    <Card title="Диагностика" action={<Btn size="xs" onClick={() => void app!.health().then(setHealth)}>Обновить</Btn>}>
      <div className="kv">
        <dt>SQLite</dt><dd>{health.database}</dd>
        <dt>Драйвер</dt><dd>{health.driver}</dd>
        <dt>Версия схемы</dt><dd>{health.schemaVersion}</dd>
        <dt>Целостность</dt><dd style={{ color: health.integrity.ok ? 'var(--accent)' : 'var(--danger)' }}>{health.integrity.ok ? 'OK' : 'проблемы!'}</dd>
        <dt>Устройство</dt><dd>{health.deviceId} ({health.platform})</dd>
        <dt>ИИ</dt><dd>{health.ai.provider} · {health.ai.offline ? 'офлайн' : 'онлайн'} · tools: {String(health.ai.capabilities.tools)}</dd>
        <dt>Onboarding</dt><dd>{health.onboarding.completed ? 'завершён' : 'не завершён'} · модель {health.onboarding.modelConfirmed ? 'подтверждена' : 'не подтверждена'}</dd>
      </div>
      <div className="section-title">Объём данных</div>
      <div className="row wrap">
        {Object.entries(health.counts).map(([table, n]) => <Tag key={table} tone="outline">{table}: {n}</Tag>)}
      </div>
    </Card>
    </>
  );
}
