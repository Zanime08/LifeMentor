import React, { useEffect, useMemo, useState } from 'react';
import type { KnowledgeMap, KnowledgeNode } from '@lifementor/core';
import { Btn, Card, Empty, Field, I, Modal, PageHead, Progress, Select, Spinner, Tag, TextInput } from '../components/ui';
import { useApp } from '../state/store';

const STATUS_RU: Record<string, string> = {
  unknown: 'не изучено', learning: 'изучаю', practiced: 'практика', mastered: 'освоено', gap: 'пробел',
};
const STATUS_COLOR: Record<string, string> = {
  unknown: '#c8cec2', learning: '#7fa8c9', practiced: '#8fb996', mastered: '#2e8a6c', gap: '#c98a7f',
};

export function Knowledge() {
  const { app, version, mutate, toast } = useApp();
  const [map, setMap] = useState<KnowledgeMap | null>(null);
  const [selected, setSelected] = useState<KnowledgeNode | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!app) return;
    let stop = false;
    app.services.knowledge.map().then((m) => { if (!stop) setMap(m); }).catch(() => undefined);
    return () => { stop = true; };
  }, [app, version]);

  // The layout must be computed before the early return below: a hook after a conditional return
  // changes the hook order between the loading render and the loaded one, which React answers with
  // "Rendered more hooks than during the previous render" — the screen never appeared at all.
  const layout = useMemo(() => (map ? layoutNodes(map) : null), [map]);

  if (!map || !layout) return <Spinner label="Строю карту знаний…" />;

  return (
    <div>
      <PageHead title="Карта знаний" sub="Связная карта направлений: узлы, зависимости и пробелы. Карта растёт вместе с обучением."
        actions={<Btn kind="primary" size="sm" onClick={() => setAdding(true)}>{I.plus} Узел</Btn>} />

      {map.nodes.length === 0 ? (
        <Empty icon={I.knowledge} title="Карта пока пуста"
          hint="Узлы создаются из onboarding (интересы и навыки) и из путей обучения. Добавьте первый узел вручную."
          action={<Btn kind="primary" size="sm" onClick={() => setAdding(true)}>Добавить узел</Btn>} />
      ) : (
        <div className="grid" style={{ gridTemplateColumns: '1.5fr 1fr', alignItems: 'start' }}>
          <div>
            <svg className="kmap" viewBox={`0 0 ${layout.width} ${layout.height}`} preserveAspectRatio="xMidYMid meet">
              {layout.edges.map((e, i) => (
                <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                  stroke={e.relation === 'prerequisite' ? 'var(--line-2)' : '#d9c9e8'}
                  strokeWidth={1.4} strokeDasharray={e.relation === 'prerequisite' ? undefined : '4 3'}
                  markerEnd={e.relation === 'prerequisite' ? 'url(#arrow)' : undefined} />
              ))}
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--line-2)" />
                </marker>
              </defs>
              {layout.nodes.map((n) => (
                <g key={n.id} className="knode" transform={`translate(${n.x},${n.y})`} onClick={() => { const node = map.nodes.find((m) => m.id === n.id); if (node) setSelected(node); }}>
                  <rect x={-n.w / 2} y={-17} width={n.w} height={34} rx={9}
                    fill={STATUS_COLOR[n.status] ?? '#c8cec2'} opacity={0.22}
                    stroke={selected?.id === n.id ? 'var(--accent)' : STATUS_COLOR[n.status] ?? '#c8cec2'} strokeWidth={selected?.id === n.id ? 2 : 1.2} />
                  <text x={0} y={4} textAnchor="middle">{n.title.length > 22 ? `${n.title.slice(0, 21)}…` : n.title}</text>
                </g>
              ))}
            </svg>
            <div className="row wrap mt-sm" style={{ gap: 12 }}>
              {Object.entries(STATUS_RU).map(([k, v]) => (
                <span key={k} className="row xsmall muted" style={{ gap: 5 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: STATUS_COLOR[k], display: 'inline-block', opacity: 0.5 }} />{v}
                </span>
              ))}
              <span className="xsmall muted">— сплошная: prerequisite · пунктир: связано</span>
            </div>
          </div>

          <div className="stack">
            <Card title="Направления">
              {map.domains.map((d) => (
                <div key={d.name} style={{ marginBottom: 8 }}>
                  <div className="row" style={{ gap: 8, justifyContent: 'space-between' }}>
                    <span className="small" style={{ fontWeight: 600 }}>{d.name}</span>
                    <span className="xsmall muted">{d.nodes} уз. · {d.average_mastery}%</span>
                  </div>
                  <div className="bar thin" style={{ marginTop: 3 }}><span style={{ width: `${d.average_mastery}%` }} /></div>
                </div>
              ))}
            </Card>

            <Card title="Пробелы" sub="Что держит другие направления">
              {map.gaps.length === 0 && <div className="small muted">Явных пробелов не видно.</div>}
              {map.gaps.map((g, i) => (
                <div key={i} className="row" style={{ gap: 8, padding: '4px 0' }}>
                  <Tag tone="p1">пробел</Tag>
                  <span className="grow small">{g.node.title}</span>
                  <span className="xsmall muted" style={{ maxWidth: 160 }}>{g.reason}</span>
                </div>
              ))}
            </Card>
          </div>
        </div>
      )}

      {selected && <NodeDetail node={selected} map={map} onClose={() => setSelected(null)} />}
      {adding && <NodeAdd onClose={() => setAdding(false)} />}
    </div>
  );
}

interface LaidNode { id: string; title: string; status: string; x: number; y: number; w: number }
interface LaidEdge { x1: number; y1: number; x2: number; y2: number; relation: string }

function layoutNodes(map: KnowledgeMap): { nodes: LaidNode[]; edges: LaidEdge[]; width: number; height: number } {
  const nodes = map.nodes;
  const byDomain = new Map<string, KnowledgeNode[]>();
  for (const name of map.domains.map((d) => d.name)) byDomain.set(name, []);
  for (const n of nodes) {
    const key = n.domain ?? 'general';
    if (!byDomain.has(key)) byDomain.set(key, []);
    byDomain.get(key)!.push(n);
  }
  const colW = 190;
  const rows = [...byDomain.values()].map((list) => [...list].sort((a, b) => a.title.localeCompare(b.title)));
  const maxRows = Math.max(1, ...rows.map((r) => r.length));
  const out: LaidNode[] = [];
  const pos = new Map<string, { x: number; y: number }>();
  rows.forEach((row, col) => {
    row.forEach((n, r) => {
      const x = 100 + col * colW;
      const y = 50 + r * 64;
      out.push({ id: n.id, title: n.title, status: n.status, x, y, w: Math.min(170, 40 + n.title.length * 7) });
      pos.set(n.id, { x, y });
    });
  });
  const edges: LaidEdge[] = [];
  for (const rel of map.relations) {
    const a = pos.get(rel.from_node_id);
    const b = pos.get(rel.to_node_id);
    if (a && b) edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, relation: rel.relation });
  }
  return { nodes: out, edges, width: 120 + rows.length * colW, height: 90 + maxRows * 64 };
}

const RELATION_RU: Record<string, string> = {
  related: 'связано', prerequisite: 'предшествует', part_of: 'часть', applies: 'применяется',
};

function NodeDetail({ node, map, onClose }: { node: KnowledgeNode; map: KnowledgeMap; onClose: () => void }) {
  const { app, mutate, toast } = useApp();
  const [status, setStatus] = useState<KnowledgeNode['status']>(node.status);
  const [mastery, setMastery] = useState(node.mastery);
  const [linkTo, setLinkTo] = useState('');
  const [relation, setRelation] = useState<'related' | 'prerequisite' | 'part_of' | 'applies'>('related');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const related = map.relations.filter((r) => r.from_node_id === node.id || r.to_node_id === node.id);
  const candidates = map.nodes.filter((n) => n.id !== node.id);
  // Confirmation lives inside this dialog, not in a second modal on top of it: escape and the
  // focus trap belong to exactly one dialog at a time.
  return (
    <Modal title={node.title} onClose={onClose} footer={
      <>
        <Btn kind="ghost" aria-label="Удалить узел" title="Удалить узел" onClick={() => setConfirmDelete(true)} disabled={confirmDelete}>{I.trash}</Btn>
        <span className="grow" />
        <Btn onClick={onClose}>Закрыть</Btn>
        <Btn kind="primary" onClick={() => void mutate(() => app!.services.knowledge.updateNode(node.id, { status, mastery }), 'Узел обновлён').then(() => onClose())}>Сохранить</Btn>
      </>
    }>
      {confirmDelete && (
        <div className="proactive" style={{ background: 'var(--danger-soft, #fbeaea)', borderColor: '#e5b4b4' }}>
          <b>Удалить узел «{node.title}»?</b>
          <div className="small mt-sm">Он исчезнет из карты, и его связи перестанут отображаться. Уже освоенное знание останется в истории изменений.</div>
          <div className="row mt-sm" style={{ gap: 8 }}>
            <Btn kind="danger" size="sm" onClick={() => void mutate(() => app!.services.knowledge.removeNode(node.id), 'Узел удалён из карты').then((ok) => { if (ok) onClose(); })}>Удалить навсегда</Btn>
            <Btn size="sm" onClick={() => setConfirmDelete(false)}>Оставить</Btn>
          </div>
        </div>
      )}
      {node.summary && <p className="small muted mb-sm">{node.summary}</p>}
      <div className="row wrap" style={{ gap: 10 }}>
        <Field label="Статус">
          <Select value={status} onChange={(e) => setStatus(e.target.value as never)} style={{ width: 170 }}>
            {Object.entries(STATUS_RU).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label={`Освоение: ${mastery}%`}>
          <input type="range" min={0} max={100} value={mastery} onChange={(e) => setMastery(Number(e.target.value))} style={{ width: 180, accentColor: 'var(--accent)' }} />
        </Field>
      </div>
      <div className="section-title">Связи</div>
      {related.length === 0 && <div className="small muted">Связей нет.</div>}
      {related.map((r) => {
        const other = r.from_node_id === node.id
          ? map.nodes.find((n) => n.id === r.to_node_id)
          : map.nodes.find((n) => n.id === r.from_node_id);
        return (
          <div key={r.id} className="row" style={{ gap: 8, padding: '3px 0' }}>
            <Tag tone={r.relation === 'prerequisite' ? 'gold' : 'violet'}>{r.relation === 'prerequisite' ? 'предшествует' : r.relation === 'part_of' ? 'часть' : r.relation === 'applies' ? 'применяется' : 'связано'}</Tag>
            <span className="small">{other?.title ?? '?'}</span>
          </div>
        );
      })}
      {candidates.length > 0 && (
        <div className="row wrap mt-sm" style={{ gap: 8 }}>
          <Select value={linkTo} onChange={(e) => setLinkTo(e.target.value)} style={{ flex: 1, minWidth: 150 }}>
            <option value="">К какому узлу…</option>
            {candidates.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
          </Select>
          <Select value={relation} onChange={(e) => setRelation(e.target.value as never)} style={{ width: 150 }}>
            {Object.entries(RELATION_RU).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <Btn
            size="sm"
            disabled={!linkTo}
            onClick={() => void mutate(
              () => app!.services.knowledge.relate({ from_node_id: node.id, to_node_id: linkTo, relation, weight: 0.5 }),
              'Связь добавлена в карту',
            ).then((r) => { if (r) { setLinkTo(''); toast('Карта обновлена: узлы теперь связаны.', 'ok'); } })}
          >Связать</Btn>
        </div>
      )}
      <div className="mt-sm small muted" onClick={() => toast('Узлы и связи обновляются из обучения, навыков и onboarding.', 'info')}>
        Карта пополняется автоматически: из путей обучения, навыков и интересов — и вручную здесь.
      </div>
    </Modal>
  );
}

function NodeAdd({ onClose }: { onClose: () => void }) {
  const { app, mutate, toast } = useApp();
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState('');
  const [status, setStatus] = useState<KnowledgeNode['status']>('unknown');
  return (
    <Modal title="Новый узел знаний" onClose={onClose} footer={
      <>
        <Btn onClick={onClose}>Отмена</Btn>
        <Btn kind="primary" disabled={!title.trim()} onClick={() => void mutate(() => app!.services.knowledge.addNode({
          title: title.trim(), domain: domain || 'general', status, mastery: status === 'mastered' ? 80 : status === 'practiced' ? 55 : status === 'learning' ? 30 : 0,
        })).then((r) => { if (r) { toast('Узел добавлен.', 'ok'); onClose(); } })}>Добавить</Btn>
      </>
    }>
      <Field label="Название"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="напр. HTTP/REST" autoFocus /></Field>
      <Field label="Направление" optional><TextInput value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="напр. backend" /></Field>
      <Field label="Статус">
        <Select value={status} onChange={(e) => setStatus(e.target.value as never)}>
          {Object.entries(STATUS_RU).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </Field>
    </Modal>
  );
}
