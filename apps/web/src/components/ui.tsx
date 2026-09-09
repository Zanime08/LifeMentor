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
export function Modal({ title, onClose, children, footer, wide }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide-modal' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
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
