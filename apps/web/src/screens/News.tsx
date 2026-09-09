import React, { useEffect, useState } from 'react';
import type { DailyDigest, NewsItem, NewsSource } from '@lifementor/core';
import { Btn, Card, Empty, Field, I, Modal, PageHead, Seg, Spinner, Tag, TextInput } from '../components/ui';
import { useApp } from '../state/store';
import { KIND_RU, timeAgo } from '../lib/ru';

const CATS = ['all', 'world', 'technology', 'ai', 'economy', 'business', 'science', 'geopolitics', 'programming'] as const;

type ItemWithSource = NewsItem & { source_name: string | null };

export function News() {
  const { app, version, mutate, toast, online, serverUrl } = useApp();
  const [items, setItems] = useState<ItemWithSource[]>([]);
  const [sources, setSources] = useState<NewsSource[]>([]);
  const [category, setCategory] = useState<(typeof CATS)[number]>('all');
  const [filter, setFilter] = useState<'all' | 'urgent' | 'saved'>('all');
  const [open, setOpen] = useState<ItemWithSource | null>(null);
  const [digest, setDigest] = useState<DailyDigest | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [serverInfo, setServerInfo] = useState<{ last_fetched_at: string | null; error: string | null; count: number } | null>(null);
  const [sourceModal, setSourceModal] = useState(false);

  const load = async () => {
    if (!app) return;
    try {
      const [it, src, dg] = await Promise.all([
        app.services.news.list({ limit: 200, category: category === 'all' ? undefined : category, urgency: filter === 'urgent' ? 'urgent' : undefined, savedOnly: filter === 'saved' || undefined }),
        app.services.news.sources(),
        app.services.news.digest(),
      ]);
      const sourceName = new Map(src.map((s) => [s.id, s.name]));
      setItems(it.map((i) => ({ ...i, source_name: i.source_id ? sourceName.get(i.source_id) ?? null : null })));
      setSources(src);
      setDigest(dg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [app, category, filter, version]);

  const fetchFromServer = async () => {
    if (!app) return;
    setFetching(true);
    try {
      const response = await fetch(`${serverUrl}/v1/news?limit=80`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setServerInfo({ last_fetched_at: null, error: body.userMessage ?? body.error ?? `HTTP ${response.status}`, count: 0 });
        return;
      }
      const data = await response.json();
      setServerInfo({ last_fetched_at: data.last_fetched_at ?? null, error: data.error ?? null, count: data.items?.length ?? 0 });
      const result = await app.services.news.ingest(data.items ?? []);
      toast(result.created + result.updated > 0
        ? `Загружено с сервера: +${result.created} новых, ${result.updated} обновлено.`
        : 'Новых элементов нет (кэш сервера пуст или все уже загружены).',
        'ok');
      await load();
    } catch (e) {
      setServerInfo({ last_fetched_at: null, error: 'Сервер недоступен — лента не обновлена', count: 0 });
      toast('Сервер новостей недоступен. Локальная лента остаётся читаемой офлайн.', 'warn');
    } finally {
      setFetching(false);
    }
  };

  if (loading) return <Spinner label="Загружаю ленту…" />;

  const urgent = items.filter((i) => i.urgency === 'urgent');

  return (
    <div>
      <PageHead title="Новости" sub="Два уровня: срочные — узнать быстро; дайджест — главные события дня. Каждое событие: что / почему важно / контекст / источник."
        actions={<Btn kind="primary" size="sm" onClick={() => void fetchFromServer()} disabled={fetching}>
          {fetching ? 'Загружаю…' : online ? '⇩ Загрузить с сервера' : 'Сервер недоступен'}
        </Btn>} />

      {serverInfo && (
        <div className="xsmall muted mb-sm">
          {serverInfo.error
            ? <>⚠ {serverInfo.error}{serverInfo.count > 0 ? ` (всё же получено ${serverInfo.count})` : ''}</>
            : <>Последняя выборка сервера: {serverInfo.last_fetched_at ? timeAgo(serverInfo.last_fetched_at) : '—'} · элементов в кэше: {serverInfo.count}</>}
        </div>
      )}

      <div className="row wrap mb" style={{ gap: 10, justifyContent: 'space-between' }}>
        <Seg value={filter} onChange={setFilter} options={[{ id: 'all', label: 'Все' }, { id: 'urgent', label: 'Срочные' }, { id: 'saved', label: 'Сохранённые' }]} />
        <div className="row wrap" style={{ gap: 5 }}>
          {CATS.map((c) => (
            <button key={c} type="button" className={`q-option ${category === c ? 'sel' : ''}`} style={{ margin: 0, padding: '5px 10px', fontSize: 12 }} onClick={() => setCategory(c)}>
              {c === 'all' ? 'Все темы' : KIND_RU[c] ?? c}
            </button>
          ))}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.5fr 1fr', alignItems: 'start' }}>
        <div>
          {items.length === 0 && (
            <Empty icon={I.news} title={online ? 'Локальная лента пуста' : 'Офлайн: пока ничего не загружено'}
              hint="Нажмите «Загрузить с сервера» — сервер собирает и структурирует новости из внешних источников."
              action={online ? <Btn kind="primary" size="sm" onClick={() => void fetchFromServer()}>Загрузить</Btn> : undefined} />
          )}
          {items.map((n) => (
            <div key={n.id} className={`list-item news-item ${n.read_at ? 'read' : ''}`} onClick={() => setOpen(n)}>
              <div className="li-main">
                <div className="li-title" style={{ whiteSpace: 'normal' }}>{n.title}</div>
                <div className="li-sub">
                  {n.source_name ?? 'источник'} · {n.published_at ? timeAgo(n.published_at) : ''}
                </div>
              </div>
              <div className="li-side">
                <Tag tone={n.urgency === 'urgent' ? 'p0' : 'outline'}>{KIND_RU[n.category] ?? n.category}</Tag>
                {n.saved_at && <Tag tone="gold">сохранено</Tag>}
              </div>
            </div>
          ))}
        </div>

        <div className="stack">
          {digest && digest.items.length > 0 && (
            <Card title="Дайджест дня" sub="Главные события за сегодня">
              {digest.text && <p className="small muted">{digest.text}</p>}
              {digest.items.map((d) => (
                <div key={d.id} className="row" style={{ gap: 8, padding: '4px 0', cursor: 'pointer' }} onClick={() => { const item = items.find((i) => i.id === d.id); if (item) setOpen(item); }}>
                  <Tag tone={d.urgency === 'urgent' ? 'p0' : 'outline'}>{KIND_RU[d.category] ?? d.category}</Tag>
                  <span className="grow small">{d.title}</span>
                </div>
              ))}
            </Card>
          )}
          <Card title="Источники" sub="Выбирает и дублирует сервер; управление на клиенте">
            {sources.length === 0 && <div className="small muted">Источники добавляются на сервере (RSS по категориям).</div>}
            {sources.map((s) => (
              <div key={s.id} className="row" style={{ gap: 8, padding: '4px 0', alignItems: 'center' }}>
                <span className="grow small">{s.name}</span>
                <Tag tone="outline">{KIND_RU[s.category] ?? s.category}</Tag>
                <input type="checkbox" checked={s.enabled === 1} style={{ accentColor: 'var(--accent)' }}
                  onChange={(e) => void mutate(() => app!.services.news.setSourceEnabled(s.id, e.target.checked))} />
              </div>
            ))}
            <Btn kind="ghost" size="xs" className="mt-sm" onClick={() => setSourceModal(true)}>＋ Свой источник (RSS)</Btn>
          </Card>
        </div>
      </div>

      {open && (
        <ItemDetail item={open} onClose={() => setOpen(null)}
          onRead={() => void mutate(() => app!.services.news.markRead(open.id)).then(() => load())}
          onSaved={() => void mutate(() => app!.services.news.markSaved(open.id)).then(() => load())} />
      )}
      {sourceModal && <AddSource onClose={() => setSourceModal(false)} onDone={() => { setSourceModal(false); void load(); }} />}
    </div>
  );
}

function ItemDetail({ item, onClose, onRead, onSaved }: { item: ItemWithSource; onClose: () => void; onRead: () => void; onSaved: () => void }) {
  return (
    <Modal title={item.title} onClose={onClose} wide footer={
      <>
        {item.url && <a href={item.url} target="_blank" rel="noreferrer"><Btn size="sm" kind="ghost">Источник ↗</Btn></a>}
        <Btn size="sm" onClick={onSaved}>Сохранить</Btn>
        <Btn kind="primary" size="sm" onClick={() => { onRead(); onClose(); }}>Прочитано</Btn>
      </>
    }>
      <div className="row wrap mb" style={{ gap: 8 }}>
        <Tag tone={item.urgency === 'urgent' ? 'p0' : 'outline'}>{item.urgency === 'urgent' ? 'срочно' : 'дайджест'}</Tag>
        <Tag tone="violet">{KIND_RU[item.category] ?? item.category}</Tag>
        {item.source_name && <Tag tone="outline">{item.source_name}</Tag>}
        {item.published_at && <span className="xsmall muted">{timeAgo(item.published_at)}</span>}
      </div>
      {item.what_happened && <Block label="Что произошло" text={item.what_happened} />}
      {item.why_it_matters && <Block label="Почему это важно" text={item.why_it_matters} />}
      {item.context && <Block label="Контекст" text={item.context} />}
      {item.impact && <Block label="Возможное влияние" text={item.impact} />}
      {item.summary && !item.what_happened && <p className="small">{item.summary}</p>}
    </Modal>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div className="mb-sm">
      <div className="xsmall" style={{ fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-3)' }}>{label}</div>
      <p className="small">{text}</p>
    </div>
  );
}

function AddSource({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { app, mutate, toast } = useApp();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState<'world' | 'technology' | 'ai' | 'economy' | 'business' | 'science' | 'geopolitics' | 'programming'>('technology');
  return (
    <Modal title="Свой RSS-источник" onClose={onClose} footer={
      <>
        <Btn onClick={onClose}>Отмена</Btn>
        <Btn kind="primary" disabled={!name.trim() || !url.trim()} onClick={() => void mutate(() => app!.services.news.addSource({ name: name.trim(), url: url.trim(), category }), 'Источник добавлен локально').then((r) => { if (r) { onDone(); toast('Источник сохранён. Сервер подхватит его при следующем обновлении.', 'ok'); } })}>Добавить</Btn>
      </>
    }>
      <Field label="Название"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Напр. Хабр" /></Field>
      <Field label="URL (RSS/Atom)"><TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/feed.xml" /></Field>
      <Field label="Категория">
        <div className="row wrap" style={{ gap: 5 }}>
          {CATS.filter((c) => c !== 'all').map((c) => (
            <button key={c} type="button" className={`q-option ${category === c ? 'sel' : ''}`} style={{ margin: 0, padding: '5px 10px', fontSize: 12 }} onClick={() => setCategory(c as never)}>{KIND_RU[c] ?? c}</button>
          ))}
        </div>
      </Field>
    </Modal>
  );
}
