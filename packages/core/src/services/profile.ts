import type { Repos } from '../db/repos';
import type { WriteContext } from '../db/repo';
import { USER_WRITE } from '../db/repo';
import type { Confidence, FactSource, ProfileField, ProfileSection } from '../domain/types';
import { PROFILE_SECTIONS } from '../domain/types';
import { newId } from '../util/id';
import { nowIso } from '../util/time';
import { AppError } from '../util/result';

export type ValueKind = 'text' | 'number' | 'bool' | 'list' | 'json' | 'scale';

export interface ProfileFieldInput {
  section: ProfileSection;
  key: string;
  label?: string;
  value: unknown;
  value_kind?: ValueKind;
  source?: FactSource;
  confidence?: Confidence;
  evidence?: string;
  importance?: number;
  /** Allow an AI-inferred value to replace a user-confirmed one (requires an explicit reason). */
  force?: boolean;
}

export interface ProfileFieldView {
  id: string;
  section: ProfileSection;
  key: string;
  label: string | null;
  value: unknown;
  value_kind: ValueKind;
  source: FactSource;
  confidence: Confidence;
  evidence: string | null;
  importance: number;
  updated_at: string;
  version: number;
}

export interface UserModel {
  sections: Record<ProfileSection, ProfileFieldView[]>;
  /** Everything the AI inferred but the user has not confirmed (req. 28). */
  assumptions: ProfileFieldView[];
  unknowns: string[];
  field_count: number;
  confirmed_ratio: number;
  updated_at: string;
}

function inferKind(value: unknown): ValueKind {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'bool';
  if (Array.isArray(value)) return 'list';
  if (value && typeof value === 'object') return 'json';
  return 'text';
}

export function decodeValue(raw: string | null, kind: ValueKind): unknown {
  if (raw === null || raw === undefined) return null;
  if (kind === 'text') return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}

export function toView(row: ProfileField): ProfileFieldView {
  return {
    id: row.id,
    section: row.section,
    key: row.field_key,
    label: row.label,
    value: decodeValue(row.value, row.value_kind as ValueKind),
    value_kind: row.value_kind as ValueKind,
    source: row.source,
    confidence: row.confidence,
    evidence: row.evidence,
    importance: row.importance,
    updated_at: row.updated_at,
    version: row.version,
  };
}

/**
 * The user model (req. 4, 28, 53, 75).
 *
 * Every field records **where it came from** and **how sure we are**, so the AI can never
 * present an inference as a fact, and the user can audit/edit/delete any of it.
 */
export class ProfileService {
  constructor(private readonly repos: Repos) {}

  async setField(input: ProfileFieldInput, ctx: WriteContext = USER_WRITE): Promise<ProfileFieldView> {
    if (!PROFILE_SECTIONS.includes(input.section)) throw AppError.validation(`Unknown profile section: ${input.section}`);
    if (!input.key || !/^[a-z0-9_.:-]+$/i.test(input.key)) throw AppError.validation(`Invalid profile key: ${input.key}`);
    const kind = input.value_kind ?? inferKind(input.value);
    const encoded = kind === 'text' ? String(input.value ?? '') : JSON.stringify(input.value ?? null);
    const source = input.source ?? 'user_provided';
    const confidence = input.confidence ?? (source === 'user_provided' ? 'confirmed' : 'inferred');

    const existing = await this.repos.profileFields.findOne({ section: input.section, field_key: input.key }, { includeDeleted: true });

    if (existing && existing.deleted === 0 && existing.source === 'user_provided' && existing.confidence === 'confirmed'
      && source !== 'user_provided' && existing.value !== encoded && !input.force) {
      // Never silently overwrite something the user stated (req. 28).
      throw AppError.conflict(
        `"${input.section}.${input.key}" was stated by the user. Provide force=true with a reason to propose a change.`,
        { current: existing.value, proposed: encoded },
      );
    }

    const reason = ctx.reason ?? `profile.${input.section}.${input.key}`;
    let row: ProfileField;
    if (existing) {
      const updated = await this.repos.profileFields.update(existing.id, {
        label: input.label ?? existing.label,
        value: encoded,
        value_kind: kind,
        source,
        confidence,
        evidence: input.evidence ?? existing.evidence,
        importance: input.importance ?? existing.importance,
        deleted: 0,
      } as never, { ...ctx, reason });
      row = updated!;
    } else {
      row = await this.repos.profileFields.insert({
        id: newId('field'),
        section: input.section,
        field_key: input.key,
        label: input.label ?? null,
        value: encoded,
        value_kind: kind,
        source,
        confidence,
        evidence: input.evidence ?? null,
        importance: input.importance ?? 0.5,
      } as never, { ...ctx, reason });
    }

    if (existing && existing.value !== encoded) {
      // Immutable evolution history for the user model.
      await this.repos.strategyChanges.insert({
        id: newId(), entity_type: 'profile_field', entity_id: row.id, field: `${input.section}.${input.key}`,
        old_value: existing.value, new_value: encoded, reason, actor: ctx.actor, created_at: nowIso(),
      } as never);
    }
    return toView(row);
  }

  async setMany(fields: ProfileFieldInput[], ctx: WriteContext = USER_WRITE): Promise<ProfileFieldView[]> {
    const out: ProfileFieldView[] = [];
    for (const field of fields) out.push(await this.setField(field, ctx));
    return out;
  }

  async getField(section: ProfileSection, key: string): Promise<ProfileFieldView | null> {
    const row = await this.repos.profileFields.findOne({ section, field_key: key });
    return row ? toView(row) : null;
  }

  async list(section?: ProfileSection): Promise<ProfileFieldView[]> {
    const rows = await this.repos.profileFields.find(section ? { section } : {}, { orderBy: { section: 'asc', importance: 'desc', field_key: 'asc' } });
    return rows.map(toView);
  }

  async confirm(id: string, ctx: WriteContext = USER_WRITE): Promise<ProfileFieldView | null> {
    const row = await this.repos.profileFields.update(id, { confidence: 'confirmed', source: 'user_provided' } as never, { ...ctx, reason: 'user confirmed' });
    return row ? toView(row) : null;
  }

  async markWrong(id: string, note?: string, ctx: WriteContext = USER_WRITE): Promise<boolean> {
    const before = await this.repos.profileFields.byId(id);
    if (!before) return false;
    await this.repos.profileFields.update(id, { deleted: 1 } as never, { ...ctx, reason: `user marked as wrong${note ? `: ${note}` : ''}` });
    await this.repos.strategyChanges.insert({
      id: newId(), entity_type: 'profile_field', entity_id: id, field: `${before.section}.${before.field_key}`,
      old_value: before.value, new_value: null, reason: note ?? 'user marked as wrong', actor: ctx.actor, created_at: nowIso(),
    } as never);
    return true;
  }

  async remove(section: ProfileSection, key: string, ctx: WriteContext = USER_WRITE): Promise<boolean> {
    const row = await this.repos.profileFields.findOne({ section, field_key: key });
    if (!row) return false;
    await this.repos.profileFields.softDelete(row.id, { ...ctx, reason: 'user removed profile field' });
    return true;
  }

  async model(): Promise<UserModel> {
    const rows = await this.repos.profileFields.find({}, { orderBy: { section: 'asc', importance: 'desc' } });
    const sections = Object.fromEntries(PROFILE_SECTIONS.map((s) => [s, [] as ProfileFieldView[]])) as Record<ProfileSection, ProfileFieldView[]>;
    const assumptions: ProfileFieldView[] = [];
    const unknowns: string[] = [];
    let confirmed = 0;
    for (const row of rows) {
      const view = toView(row);
      (sections[view.section] ??= []).push(view);
      if (view.confidence === 'confirmed') confirmed += 1;
      else assumptions.push(view);
      if (view.source === 'unknown' || view.value === null || view.value === '') unknowns.push(`${view.section}.${view.key}`);
    }
    return {
      sections,
      assumptions,
      unknowns,
      field_count: rows.length,
      confirmed_ratio: rows.length ? confirmed / rows.length : 0,
      updated_at: nowIso(),
    };
  }

  /** Freeze the current model (onboarding confirmation, monthly review, before import). */
  async snapshot(trigger: string): Promise<UserModelSnapshotRow> {
    const model = await this.model();
    const row = await this.repos.userModelSnapshots.insert({
      id: newId(), trigger, model_json: JSON.stringify(model), created_at: nowIso(),
    } as never);
    return { id: row.id, trigger: row.trigger, created_at: row.created_at, model: JSON.parse(row.model_json) as UserModel };
  }

  async snapshots(limit = 10): Promise<{ id: string; trigger: string; created_at: string }[]> {
    const rows = await this.repos.userModelSnapshots.find({}, { orderBy: { created_at: 'desc' }, limit });
    return rows.map((r) => ({ id: r.id, trigger: r.trigger, created_at: r.created_at }));
  }

  /** Compact, token-friendly rendering for the AI context engine. */
  async contextText(maxFieldsPerSection = 6): Promise<string> {
    const model = await this.model();
    const lines: string[] = [];
    for (const section of PROFILE_SECTIONS) {
      const fields = model.sections[section];
      if (!fields?.length) continue;
      const parts = fields.slice(0, maxFieldsPerSection).map((f) => {
        const value = Array.isArray(f.value) ? f.value.join(', ') : typeof f.value === 'object' && f.value ? JSON.stringify(f.value) : String(f.value);
        const tag = f.confidence === 'confirmed' ? '' : f.source === 'ai_inferred' ? ' (assumption)' : ' (observed)';
        return `${f.label ?? f.key}: ${value}${tag}`;
      });
      lines.push(`${section}: ${parts.join('; ')}`);
    }
    return lines.join('\n');
  }
}

export interface UserModelSnapshotRow { id: string; trigger: string; created_at: string; model: UserModel }
