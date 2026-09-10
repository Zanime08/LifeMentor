import React, { useEffect, useState } from 'react';
import { useApp } from '../state/store';

/* ── icons (emoji, dependency-free) ─────────────────────────────────── */
export const I = {
  dashboard: '◧', mentor: '✦', today: '☀', calendar: '▦', goals: '◉', learning: '❧',
  projects: '⬡', skills: '♛', knowledge: '⌘', news: '◈', progress: '↗', profile: '◍',
  settings: '⚙', bell: '◔', plus: '＋', check: '✓', x: '✕', trash: '🗑', edit: '✎',
  cloud: '☁', offline: '⚠', user: '◉', lock: '⛨', download: '⇩', upload: '⇧', play: '▶',
};

/* ── primitives ─────────────────────────────────────────────────────── */
export function Btn(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'danger' | 'ghost' | 'plain'; size?: 'sm' | 'xs' | 'md' }) {
  const { kind = 'plain', size = 'md', className = '', ...rest } = props;
  const cls = ['btn', kind !== 'plain' ? kind : '', size === 'sm' ? 'sm' : size === 'xs' ? 'xs' : '', className].filter(Boolean).join(' ');
  return <button type="button" {...rest} className={cls} />;
}

export function Card(props: { title?: React.ReactNode; sub?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={`card ${props.className ?? ''}`}>
      {props.title && (
        <div className="row mb-sm">
          <div className="grow">
            <h3>{props.title}</h3>
            {props.sub && <div className="card-sub">{props.sub}</div>}
          </div>
          {props.action}
        </div>
      )}
      <div className={props.bodyClass}>{props.children}</div>
    </section>
  );
}

export function Progress({ value, thin }: { value: number; thin?: boolean }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="row" style={{ gap: 8 }}>
      <div className={`bar grow ${thin ? 'thin' : ''}`}><span style={{ width: `${v}%` }} /></div>
      <span className="pct">{v}%</span>
    </div>
  );
}

export function Tag({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={`tag ${tone ?? ''}`}>{children}</span>;
}

export function Empty({ icon = '◌', title, hint, action }: { icon?: string; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-ico">{icon}</div>
      <div style={{ fontWeight: 600, color: 'var(--ink-2)', marginBottom: 2 }}>{title}</div>
      {hint && <div className="small muted">{hint}</div>}
      {action && <div className="mt-sm">{action}</div>}
    </div>
  );
}

/**
 * A screen whose data could not be read. Every loader used to end with `.catch(() => undefined)`, so
 * a broken read looked exactly like an empty account (or a spinner that never stopped).
 */
export function LoadFailure({ what, message, onRetry }: { what: string; message: string; onRetry?: () => void }) {
  return (
    <Empty icon={I.offline} title={`Не удалось загрузить ${what}`}
      hint={`${message} Данные на диске не тронуты — Настройки → Диагностика проверят базу.`}
      action={onRetry ? <Btn kind="ghost" size="sm" onClick={onRetry}>Повторить</Btn> : undefined} />
  );
}

export function Spinner({ label }: { label?: string }) {
  return <div className="row" style={{ gap: 10, color: 'var(--ink-3)' }}><span className="spin" />{label && <span className="small">{label}</span>}</div>;
}

export function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[] }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.id} type="button" className={o.id === value ? 'active' : ''} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

/* ── modal ──────────────────────────────────────────────────────────── */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog primitive (req. 61: keyboard and screen-reader usable).
 *
 * It is a real `role="dialog"` with `aria-modal` and a label taken from its title, it moves focus
 * inside when it opens, keeps Tab/Shift+Tab within its own controls, closes on Escape or a click on
 * the backdrop, and returns focus to whatever opened it. Without the focus trap a keyboard user
 * tabs straight into the page behind the dialog — which is still interactive, just invisible.
 */
export function Modal({ title, onClose, children, footer, wide }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] => {
      const all = [...(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      // `checkVisibility` is unavailable in older WebViews (and in jsdom): assume visible there.
      return all.filter((el) => {
        const check = (el as unknown as { checkVisibility?: () => boolean }).checkVisibility;
        return typeof check === 'function' ? check.call(el) : true;
      });
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = Boolean(active && boxRef.current?.contains(active));
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    // Capture phase: the dialog owns its keys even if something below listens for them.
    window.addEventListener('keydown', onKey, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Prefer the first field: a dialog that asks for something should be ready to type into. The
    // close button is a fallback for read-only dialogs (confirmations, previews).
    const list = focusables();
    const firstField = list.find((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
    (firstField ?? list[0] ?? boxRef.current)?.focus?.();

    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      // Put the user back where they were: closing a dialog must not lose their place.
      if (opener && document.contains(opener)) opener.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className={`modal ${wide ? 'wide-modal' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={boxRef}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <div className="spacer" style={{ flex: 1 }} />
          <Btn kind="ghost" size="sm" onClick={onClose} aria-label="Закрыть">{I.x}</Btn>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function useModal<T>(): [T | null, (value: T) => void, (form?: (v: T) => void) => void, (value: T, apply?: (v: T) => void) => void, (value: T, apply?: (v: T) => void) => void] {
  const [open, setOpen] = useState<T | null>(null);
  return [
    open,
    (v) => setOpen(v),
    () => setOpen(null),
    (v, apply) => { if (apply) apply(v); setOpen(null); },
    (v, apply) => { if (apply) apply(v); setOpen(null); },
  ];
}

export function Confirm({ title, text, confirmLabel = 'Удалить', danger = true, onConfirm, onClose }: { title: string; text: React.ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <Btn onClick={onClose}>Отмена</Btn>
        <Btn kind={danger ? 'danger' : 'primary'} onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</Btn>
      </>
    }>
      <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{text}</div>
    </Modal>
  );
}

/* ── form field wrappers ────────────────────────────────────────────── */
export function Field({ label, hint, children, optional }: { label: string; hint?: string; children: React.ReactNode; optional?: boolean }) {
  return (
    <div className="field">
      <label>{label}{optional && <span className="muted"> · необязательно</span>}</label>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className="input" />;
}
export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className="textarea" />;
}
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className="select" />;
}

/* ── toasts ─────────────────────────────────────────────────────────── */
export function Toasts() {
  const { toasts, dismissToast } = useApp();
  // The container is always mounted (empty when idle) so screen readers
  // reliably announce items via aria-live.
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="grow">{t.text}</span>
          <button type="button" className="btn ghost sm" style={{ color: 'inherit', borderColor: 'transparent' }} onClick={() => dismissToast(t.id)} aria-label="Закрыть уведомление">{I.x}</button>
        </div>
      ))}
    </div>
  );
}

/* ── misc ───────────────────────────────────────────────────────────── */
export function PageHead({ title, sub, actions }: { title: string; sub?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="row wrap mb" style={{ justifyContent: 'space-between' }}>
      <div>
        <h1>{title}</h1>
        {sub && <div className="muted small mt-sm" style={{ marginTop: 4 }}>{sub}</div>}
      </div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="section-title">{children}</div>;
}

/** Simple SVG bar chart (no dependencies). */
export function BarChart({ data, height = 120, alt }: { data: { label: string; value: number; value2?: number }[]; height?: number; alt?: string }) {
  const w = data.length * 34 + 20;
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.value2 ?? 0)));
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${height + 22}`} style={{ maxHeight: height + 22 }} aria-label={alt ?? 'chart'}>
      {data.map((d, i) => {
        const h = (d.value / max) * (height - 14);
        const h2 = d.value2 != null ? (d.value2 / max) * (height - 14) : 0;
        const x = 12 + i * 34;
        return (
          <g key={i}>
            {d.value2 != null && <rect className="bar-rect alt" x={x + 13} y={height - h2} width={11} height={Math.max(1, h2)} rx={2} />}
            <rect className="bar-rect" x={x} y={height - h} width={11} height={Math.max(1, h)} rx={2}>
              <title>{`${d.label}: ${d.value}${d.value2 != null ? ` / ${d.value2}` : ''}`}</title>
            </rect>
            <text x={x + 5} y={height + 13} textAnchor="middle">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function Stars({ value, onChange }: { value: number; onChange?: (v: number) => void }) {
  return (
    <span className="stars" role={onChange ? 'slider' : undefined} aria-valuenow={value}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={n <= value ? '' : 'off'} onClick={onChange ? () => onChange(n) : undefined}>★</span>
      ))}
    </span>
  );
}
