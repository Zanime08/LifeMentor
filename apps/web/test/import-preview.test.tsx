// @vitest-environment jsdom
/**
 * Reading an archive before importing it (req. 54; phase-20 hardening).
 *
 * Settings → «Данные и резервные копии» offered «Слить с текущим / Заменить всё» for a file it had
 * never looked at: `previewImport()` computed exactly what the import would create, update, skip and
 * delete — and which sections it could not read at all — and the screen discarded the whole answer.
 * A file from a newer build, a tampered file, or someone else's JSON was indistinguishable from a
 * clean export until after the account had been replaced with it.
 *
 * This walks the real screen over the real engine: the archive is produced by the app's own export,
 * then handed back through the file input.
 */
import React from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../src/core/app', async () => await import('./support/app-harness'));

import { LifeMentorApp, MemoryBackupStorage } from '@lifementor/core';
import App from '../src/App';
import { bootstrapApp, disposeHarness, openApp } from './support/app-harness';

const user = userEvent.setup();

afterEach(() => {
  cleanup();
  window.location.hash = '#/';
});

afterAll(async () => {
  await disposeHarness();
});

/** Open the Data tab of Settings on an app that is past onboarding. */
async function openDataTab() {
  const app = await bootstrapApp();
  const flags = await app.services.settings.get('flags');
  if (!flags.onboarding_completed) {
    await app.services.onboarding.start();
    await app.services.onboarding.complete();
  }
  window.location.hash = '#/settings';
  render(<App />);
  const tab = await screen.findByRole('button', { name: 'Данные и резервные копии' }, { timeout: 30_000 });
  await user.click(tab);
  await screen.findByText('Экспорт и импорт', {}, { timeout: 20_000 });
  return app;
}

/**
 * An archive as another device would produce it: a real second client on its own database, exported
 * through the same `exportArchive()` the export button uses.
 */
async function archiveFromAnotherDevice(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'lifementor-other-'));
  const other = await LifeMentorApp.create({
    driverOptions: { kind: 'node', path: join(directory, 'other.sqlite') },
    deviceId: 'device-other',
    backup: { storage: new MemoryBackupStorage(), onFirstLaunch: false },
    recover: false,
    maintenance: { enabled: false },
  });
  try {
    const goal = await other.services.goals.create({ title: 'Цель с другого устройства', horizon: 'short' });
    await other.services.tasks.create({ title: 'Задача с другого устройства', estimated_minutes: 30, goal_id: goal.id });
    const archive = await other.services.backup.exportArchive();
    return JSON.stringify(archive);
  } finally {
    await other.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The real `<input type="file">` the «Импорт из архива» button opens. */
function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('the import file input is not on the screen');
  return input;
}

describe('the import preview describes the file before it is applied', () => {
  it('lists what will arrive, and says in Russian that part of the file will be skipped', async () => {
    const app = await openDataTab();
    await app.services.goals.create({ title: 'Цель из архива', horizon: 'short' });
    await app.services.tasks.create({ title: 'Задача из архива', estimated_minutes: 20 });
    const archive = await app.services.backup.exportArchive();

    // A section this build does not know (a file from a newer version) and a broken settings row:
    // the importer skips both, and the person must be told that before the account is replaced.
    const tampered = {
      ...archive,
      data: {
        ...archive.data,
        holo_deck: [{ id: 'x', title: 'Something a newer build wrote' }],
        setting: [
          { key: 'planning', value: '{not json' },          // a group this build has, unreadable
          { key: 'holo_deck', value: '{"x":1}' },           // a group a newer build invented
        ],
      },
    };

    await user.upload(fileInput(), new File([JSON.stringify(tampered)], 'LifeMentor-export.json', { type: 'application/json' }));

    // ── what the import will do ─────────────────────────────────────────────────
    await screen.findByText(/Файл: LifeMentor-export\.json/, {}, { timeout: 20_000 });
    const panel = (await screen.findByText(/Файл: LifeMentor-export\.json/)).closest('.proactive') as HTMLElement;
    expect(panel.textContent).toMatch(/Создано: \d+ · Обновлено: \d+ · Пропущено: \d+/);
    // The sections are named in Russian, not by their table name.
    expect(panel.textContent).toContain('цели');
    expect(panel.textContent).toContain('задачи');
    expect(panel.textContent).not.toContain('goal:');

    // ── what will NOT arrive ────────────────────────────────────────────────────
    expect(panel.textContent).toContain('Неизвестный раздел «holo_deck» — пропущен.');
    expect(panel.textContent).toContain('Настройки «planning» из файла не читаются — они будут пропущены.');
    expect(panel.textContent).toContain('Настройки «holo_deck» эта версия не знает — они не перенесутся.');
    expect(panel.textContent).not.toContain('Unknown entity type'); // the engine's English stays out
    // The archive is damaged, and the panel says so rather than pretending.
    expect(panel.textContent).toContain('Файл выглядит повреждённым');

    // Nothing has been written yet: the file is only being described.
    expect((await app.services.goals.list({ status: 'active' })).length).toBe(1);
  }, 180_000);

  it('refuses a file that is not an archive at all, without offering the buttons', async () => {
    await openDataTab();

    await user.upload(fileInput(), new File(['{"hello":"world"}'], 'notes.json', { type: 'application/json' }));

    const alert = await screen.findByRole('alert', {}, { timeout: 20_000 });
    expect(alert.textContent).toContain('Это не архив LifeMentor');
    expect(screen.queryByRole('button', { name: 'Заменить всё' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Слить с текущим' })).toBeNull();

    // A file from a newer build is named as such, not as a broken one.
    await user.upload(fileInput(), new File([JSON.stringify({ manifest: { format_version: 99 }, data: {} })], 'future.json', { type: 'application/json' }));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('более новой версией LifeMentor');
    });
  }, 180_000);

  it('offers the modes for a clean archive, and the merge really imports it', async () => {
    const app = await openDataTab();
    const archive = await archiveFromAnotherDevice();
    expect((await app.services.goals.list({ status: 'active' })).some((g) => g.title === 'Цель с другого устройства')).toBe(false);

    await user.upload(fileInput(), new File([archive], 'LifeMentor-export.json', { type: 'application/json' }));
    const panel = (await screen.findByText(/Файл: LifeMentor-export\.json/, {}, { timeout: 20_000 })).closest('.proactive') as HTMLElement;
    expect(panel.textContent).not.toContain('выглядит повреждённым');
    expect(panel.textContent).toContain('цели: 1');
    expect(panel.textContent).toContain('задачи: 1');

    await user.click(await screen.findByRole('button', { name: 'Слить с текущим' }));
    // The import really ran: the other device's goal and task are in this account's database.
    await waitFor(async () => {
      expect((await openApp()!.services.goals.list({ status: 'active' })).some((g) => g.title === 'Цель с другого устройства')).toBe(true);
      const tasks = await openApp()!.services.tasks.backlog(50);
      expect(tasks.some((t) => t.title === 'Задача с другого устройства')).toBe(true);
    }, { timeout: 30_000 });
  }, 180_000);
});
