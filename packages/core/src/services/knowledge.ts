import { z } from 'zod';
import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { KnowledgeNode, KnowledgeNodeLink, KnowledgeRelationship } from '../domain/types';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { AppError } from '../util/result';

export const CreateNodeSchema = z.object({
  title: z.string().trim().min(1).max(200),
  domain: z.string().trim().max(80).nullish(),
  summary: z.string().trim().max(2000).nullish(),
  mastery: z.number().int().min(0).max(100).default(0),
  status: z.enum(['unknown', 'learning', 'practiced', 'mastered', 'gap']).default('unknown'),
  parent_id: z.string().nullish(),
});
export type CreateNodeInput = z.input<typeof CreateNodeSchema>;

export const RelateSchema = z.object({
  from_node_id: z.string(),
  to_node_id: z.string(),
  relation: z.enum(['prerequisite', 'related', 'part_of', 'applies']).default('related'),
  weight: z.number().min(0).max(1).default(0.5),
  note: z.string().max(500).nullish(),
});

export interface KnowledgeMap {
  nodes: KnowledgeNode[];
  relations: KnowledgeRelationship[];
  links: KnowledgeNodeLink[];
  domains: { name: string; nodes: number; average_mastery: number }[];
  gaps: { node: KnowledgeNode; reason: string }[];
}

/**
 * Knowledge map (req. 43): a graph the system grows with the user, so it can see gaps,
 * suggest the next node, and explain how two domains connect.
 */
export class KnowledgeService {
  constructor(private readonly repos: Repos) {}

  async addNode(input: CreateNodeInput, ctx: WriteContext = USER_WRITE): Promise<KnowledgeNode> {
    const parsed = CreateNodeSchema.parse(input);
    const existing = await this.repos.knowledgeNodes.findOne({ title: parsed.title, domain: parsed.domain ?? null });
    if (existing) return existing;
    if (parsed.parent_id && !(await this.repos.knowledgeNodes.byId(parsed.parent_id))) throw AppError.notFound('knowledge node', parsed.parent_id);
    return this.repos.knowledgeNodes.insert({
      id: newId('node'), title: parsed.title, domain: parsed.domain ?? null, summary: parsed.summary ?? null,
      mastery: parsed.mastery, status: parsed.status, parent_id: parsed.parent_id ?? null,
    } as never, { ...ctx, reason: 'knowledge node added' });
  }

  async updateNode(id: string, patch: Partial<{ title: string; domain: string | null; summary: string | null; mastery: number; status: KnowledgeNode['status']; parent_id: string | null }>, ctx: WriteContext = USER_WRITE): Promise<KnowledgeNode> {
    const updated = await this.repos.knowledgeNodes.update(id, patch as never, { ...ctx, reason: 'knowledge node updated' });
    if (!updated) throw AppError.notFound('knowledge node', id);
    return updated;
  }

  async relate(input: z.infer<typeof RelateSchema>, ctx: WriteContext = USER_WRITE): Promise<KnowledgeRelationship> {
    const parsed = RelateSchema.parse(input);
    if (parsed.from_node_id === parsed.to_node_id) throw AppError.validation('A node cannot relate to itself.');
    for (const id of [parsed.from_node_id, parsed.to_node_id]) {
      if (!(await this.repos.knowledgeNodes.byId(id))) throw AppError.notFound('knowledge node', id);
    }
    const existing = await this.repos.knowledgeRelationships.findOne({ from_node_id: parsed.from_node_id, to_node_id: parsed.to_node_id, relation: parsed.relation });
    if (existing) return existing;
    return this.repos.knowledgeRelationships.insert({
      id: newId(), from_node_id: parsed.from_node_id, to_node_id: parsed.to_node_id, relation: parsed.relation,
      weight: parsed.weight, note: parsed.note ?? null, created_at: nowIso(),
    } as never, ctx);
  }

  async linkEntity(nodeId: string, entityType: KnowledgeNodeLink['entity_type'], entityId: string, ctx: WriteContext = USER_WRITE): Promise<void> {
    const existing = await this.repos.knowledgeNodeLinks.findOne({ node_id: nodeId, entity_type: entityType, entity_id: entityId });
    if (existing) return;
    await this.repos.knowledgeNodeLinks.insert({ id: newId(), node_id: nodeId, entity_type: entityType, entity_id: entityId, created_at: nowIso() } as never, ctx);
  }

  async linksFor(entityType: string, entityId: string): Promise<KnowledgeNode[]> {
    const links = await this.repos.knowledgeNodeLinks.find({ entity_type: entityType, entity_id: entityId }, { limit: 200 });
    const out: KnowledgeNode[] = [];
    for (const link of links) {
      const node = await this.repos.knowledgeNodes.byId(link.node_id);
      if (node) out.push(node);
    }
    return out;
  }

  async removeNode(id: string, ctx: WriteContext = USER_WRITE): Promise<boolean> {
    const node = await this.repos.knowledgeNodes.byId(id);
    if (!node) return false;
    await this.repos.knowledgeNodes.softDelete(id, { ...ctx, reason: 'knowledge node removed' });
    return true;
  }

  async map(): Promise<KnowledgeMap> {
    const [nodes, relations, links] = await Promise.all([
      this.repos.knowledgeNodes.find({}, { orderBy: { domain: 'asc', title: 'asc' }, limit: 2000 }),
      this.repos.knowledgeRelationships.find({}, { limit: 5000 }),
      this.repos.knowledgeNodeLinks.find({}, { limit: 5000 }),
    ]);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const domains = new Map<string, { total: number; mastery: number }>();
    for (const node of nodes) {
      const key = node.domain ?? 'general';
      const entry = domains.get(key) ?? { total: 0, mastery: 0 };
      entry.total += 1; entry.mastery += Number(node.mastery ?? 0);
      domains.set(key, entry);
    }
    const gaps = await this.gaps();
    return {
      nodes, relations, links,
      domains: [...domains.entries()].map(([name, v]) => ({ name, nodes: v.total, average_mastery: Math.round(v.mastery / Math.max(1, v.total)) })).sort((a, b) => b.nodes - a.nodes),
      gaps,
    };
  }

  /** What the user is missing: explicit gaps + unmet prerequisites. */
  async gaps(): Promise<{ node: KnowledgeNode; reason: string }[]> {
    const nodes = await this.repos.knowledgeNodes.find({}, { limit: 2000 });
    const relations = await this.repos.knowledgeRelationships.find({ relation: 'prerequisite' }, { limit: 5000 });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const out: { node: KnowledgeNode; reason: string }[] = [];

    for (const node of nodes) {
      if (node.status === 'gap') out.push({ node, reason: 'Marked as a gap' });
    }
    for (const rel of relations) {
      const target = byId.get(rel.to_node_id);
      const prerequisite = byId.get(rel.from_node_id);
      if (!target || !prerequisite) continue;
      if (Number(target.mastery) > 20 && Number(prerequisite.mastery) < 40) {
        out.push({ node: prerequisite, reason: `Prerequisite for "${target.title}" (currently ${Math.round(Number(prerequisite.mastery))}%)` });
      }
    }
    const seen = new Set<string>();
    return out.filter((g) => (seen.has(g.node.id) ? false : (seen.add(g.node.id), true)));
  }

  /**
   * Next best nodes to learn: prerequisites satisfied, linked to an active goal/skill,
   * low mastery, high relation weight.
   */
  async suggestNext(options: { goalIds?: string[]; skillIds?: string[]; limit?: number } = {}): Promise<{ node: KnowledgeNode; reason: string; score: number }[]> {
    const nodes = await this.repos.knowledgeNodes.find({}, { limit: 2000 });
    const relations = await this.repos.knowledgeRelationships.find({}, { limit: 5000 });
    const links = await this.repos.knowledgeNodeLinks.find({}, { limit: 5000 });
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const relevantEntityIds = new Set<string>([...(options.goalIds ?? []), ...(options.skillIds ?? [])]);
    const scored = nodes
      .filter((n) => n.status !== 'mastered' && Number(n.mastery) < 85)
      .map((node) => {
        let score = 0;
        const reasons: string[] = [];
        const nodeLinks = links.filter((l) => l.node_id === node.id);
        if (nodeLinks.some((l) => relevantEntityIds.has(l.entity_id))) { score += 0.45; reasons.push('linked to your active goal/skill'); }
        const prereqs = relations.filter((r) => r.to_node_id === node.id && r.relation === 'prerequisite');
        const unmet = prereqs.filter((r) => Number(byId.get(r.from_node_id)?.mastery ?? 0) < 40);
        if (prereqs.length && unmet.length === 0) { score += 0.25; reasons.push('prerequisites are ready'); }
        if (unmet.length) { score -= 0.3; reasons.push(`missing prerequisite: ${unmet.map((r) => byId.get(r.from_node_id)?.title).filter(Boolean).join(', ')}`); }
        const related = relations.filter((r) => (r.from_node_id === node.id || r.to_node_id === node.id) && r.relation !== 'prerequisite');
        score += Math.min(0.2, related.reduce((acc, r) => acc + Number(r.weight ?? 0.5), 0) * 0.05);
        if (related.length) reasons.push(`connects to ${related.length} other topic${related.length === 1 ? '' : 's'}`);
        score += (100 - Number(node.mastery)) / 100 * 0.1;
        return { node, reason: reasons.join('; ') || 'new area', score: Number(score.toFixed(3)) };
      })
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, options.limit ?? 6);
  }

  /** Cross-domain bridges — how two areas of the user's life connect. */
  async bridges(): Promise<{ from: KnowledgeNode; to: KnowledgeNode; relation: string; note: string }[]> {
    const relations = await this.repos.knowledgeRelationships.find({ relation: { op: 'in', value: ['related', 'applies'] } }, { limit: 2000 });
    const out: { from: KnowledgeNode; to: KnowledgeNode; relation: string; note: string }[] = [];
    for (const rel of relations) {
      const [from, to] = await Promise.all([this.repos.knowledgeNodes.byId(rel.from_node_id), this.repos.knowledgeNodes.byId(rel.to_node_id)]);
      if (!from || !to) continue;
      if ((from.domain ?? 'general') === (to.domain ?? 'general')) continue;
      out.push({ from, to, relation: rel.relation, note: rel.note ?? `${from.domain ?? from.title} ↔ ${to.domain ?? to.title}` });
    }
    return out;
  }

  /** Seed the map from the confirmed user model (interests + skills) after onboarding. */
  async seedFromProfile(interests: string[], skills: { name: string; domain?: string | null; level?: number }[], ctx: WriteContext = USER_WRITE): Promise<number> {
    let created = 0;
    for (const interest of interests) {
      const node = await this.addNode({ title: interest, domain: interest, status: 'learning', mastery: 5 }, ctx);
      if (node) created += 1;
    }
    for (const skill of skills) {
      const domain = skill.domain ?? skill.name;
      const node = await this.addNode({
        title: skill.name, domain, status: (skill.level ?? 0) >= 70 ? 'practiced' : (skill.level ?? 0) >= 30 ? 'learning' : 'unknown',
        mastery: Math.max(0, Math.min(100, skill.level ?? 0)),
      }, ctx);
      created += 1;
      const domainNode = await this.addNode({ title: domain, domain, status: 'unknown', mastery: 0 }, ctx);
      if (domainNode && node && domainNode.id !== node.id) {
        await this.relate({ from_node_id: domainNode.id, to_node_id: node.id, relation: 'part_of', weight: 0.8 }, ctx);
      }
    }
    return created;
  }

  async contextText(limit = 12): Promise<string> {
    const nodes = await this.repos.knowledgeNodes.find({}, { orderBy: { mastery: 'desc' }, limit });
    if (!nodes.length) return '';
    return nodes.map((n) => `- ${n.title}${n.domain ? ` [${n.domain}]` : ''}: ${Math.round(Number(n.mastery))}% (${n.status})`).join('\n');
  }
}
