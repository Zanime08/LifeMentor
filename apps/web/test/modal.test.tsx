// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Btn, Modal } from '../src/components/ui';

/**
 * Dialog contract (req. 61 — the app must be usable with a keyboard and a screen reader).
 *
 * The dialogs are used everywhere (task, event, goal, memory, confirmation, import preview…), and
 * a keyboard user must not be able to tab out of one into the page behind it, nor lose their place
 * when it closes.
 */

afterEach(cleanup);

function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Открыть</button>
      <button type="button">Фоновая кнопка</button>
      {open && (
        <Modal title="Редактирование задачи" onClose={() => { setOpen(false); onClose(); }} footer={<Btn>Сохранить</Btn>}>
          <input aria-label="Название" />
        </Modal>
      )}
    </div>
  );
}

function openDialog(onClose: () => void = () => undefined) {
  render(<Harness onClose={onClose} />);
  const trigger = screen.getByRole('button', { name: 'Открыть' });
  // Focus first, then activate: exactly what a keyboard user does (and what the browser does with
  // a click on most platforms), so the dialog has somewhere to return focus to.
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole('dialog') };
}

describe('Modal dialog contract', () => {
  it('is announced as a modal dialog labelled by its title', () => {
    const { dialog } = openDialog();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    // `useId` produces ids like `:r0:` — valid as an ID/ARIA reference, invalid in a CSS selector,
    // so the test looks the label up the way a browser resolves it.
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Редактирование задачи');
  });

  it('moves focus inside when it opens and returns it when it closes', () => {
    const { trigger, dialog } = openDialog();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(screen.getByLabelText('Название'));

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps Tab and Shift+Tab inside the dialog', () => {
    const { dialog } = openDialog();
    const close = screen.getByRole('button', { name: 'Закрыть' });
    const field = screen.getByLabelText('Название');
    const save = screen.getByRole('button', { name: 'Сохранить' });

    // DOM order inside the dialog: close button → field → footer button.
    save.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(save);

    // A middle element keeps the browser's own behaviour (no preventDefault needed).
    field.focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('locks background scrolling while it is open', () => {
    const { dialog } = openDialog();
    expect(dialog).toBeTruthy();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on a backdrop click but not on a click inside the dialog', () => {
    let closed = 0;
    const { dialog } = openDialog(() => { closed += 1; });
    fireEvent.mouseDown(dialog);
    expect(closed).toBe(0);
    fireEvent.mouseDown(dialog.parentElement!);
    expect(closed).toBe(1);
  });
});
