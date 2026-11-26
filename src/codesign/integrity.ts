// 完整性校验：区分「损坏/缺失」（硬错误）与「语义待确认」（警告）。
// 注意：真实分享数据表明 screen.slices_count 与 manifest 长度不一致，
// 且 exportable.size 是倍率而不是字节数，因此这两项不能用于完整性判断。

import { config } from '../config.js';
import { CodesignError } from './errors.js';
import type { SharingDetail, SliceManifest, SpecLayer, SpecObject } from './types.js';

export interface IntegrityIssue {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface IntegrityReport {
  ok: boolean;
  warnings: IntegrityIssue[];
  stats: Record<string, number>;
}

export type IntegrityErrorCode = 'SHARING_INCOMPLETE' | 'META_INCOMPLETE' | 'SLICE_INCOMPLETE';

function report(stats: Record<string, number>, warnings: IntegrityIssue[] = []): IntegrityReport {
  return { ok: warnings.every((w) => w.code.startsWith('WARN_')), warnings, stats };
}

function issue(code: string, message: string, details?: Record<string, unknown>): IntegrityIssue {
  return { code, message, details };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasValidRect(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((k) => isFiniteNumber(r[k]));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function inspectLayers(nodes: SpecLayer[], rootId?: string): {
  duplicateIds: number;
  orphanParents: number;
  badRects: number;
  exportables: number;
  ids: Set<string>;
} {
  const ids = new Set<string>();
  let duplicateIds = 0;
  let badRects = 0;
  let exportables = 0;
  for (const node of nodes) {
    if (!nonEmptyString(node.object_id)) continue;
    if (ids.has(node.object_id)) duplicateIds += 1;
    else ids.add(node.object_id);
    if (!hasValidRect(node.rect)) badRects += 1;
    if (node.exportable === true) exportables += 1;
  }
  const parentRoots = new Set(ids);
  if (nonEmptyString(rootId)) parentRoots.add(rootId);
  let orphanParents = 0;
  for (const node of nodes) {
    if (nonEmptyString(node.parent_id) && !parentRoots.has(node.parent_id)) orphanParents += 1;
  }
  return { duplicateIds, orphanParents, badRects, exportables, ids };
}

export function inspectSharingDetail(detail: SharingDetail): IntegrityReport {
  const warnings: IntegrityIssue[] = [];
  const designs = Array.isArray(detail.designs) ? detail.designs : [];
  const screens = designs.flatMap((d) => (Array.isArray(d?.screens) ? d.screens : []));
  let missingMetaUrl = 0;
  let missingSlicesUrl = 0;
  const seen = new Set<string>();
  let duplicateScreenIds = 0;
  for (const s of screens) {
    if (!nonEmptyString(s?.meta_url)) missingMetaUrl += 1;
    if (!nonEmptyString(s?.slices_url)) missingSlicesUrl += 1;
    const key = `${s?.id ?? ''}:${s?.object_id ?? ''}`;
    if (seen.has(key)) duplicateScreenIds += 1;
    else seen.add(key);
  }
  if (designs.length === 0 || screens.length === 0) {
    warnings.push(issue('SHARING_EMPTY', 'sharing has no designs or screens'));
  }
  if (missingMetaUrl > 0) {
    warnings.push(issue('SHARING_META_URL_MISSING', 'some screens have no meta_url', { missingMetaUrl }));
  }
  if (missingSlicesUrl > 0) {
    warnings.push(issue('WARN_SLICES_URL_MISSING', 'some screens have no slices_url', { missingSlicesUrl }));
  }
  if (duplicateScreenIds > 0) {
    warnings.push(issue('WARN_DUPLICATE_SCREEN', 'duplicate screen id/object_id pairs', { duplicateScreenIds }));
  }
  return report(
    { designs: designs.length, screens: screens.length, missingMetaUrl, missingSlicesUrl, duplicateScreenIds },
    warnings,
  );
}

export function inspectSpec(spec: SpecObject): IntegrityReport {
  const warnings: IntegrityIssue[] = [];
  const layers = Array.isArray(spec.layers) ? spec.layers : [];
  const groups = Array.isArray(spec.groups) ? spec.groups : [];
  const all = [...layers, ...groups];
  const nodes = inspectLayers(all, spec.object_id);
  const cssCount = Array.isArray(spec.css) ? spec.css.length : typeof spec.css === 'string' ? 1 : 0;

  if (!nonEmptyString(spec.object_id)) {
    warnings.push(issue('SPEC_OBJECT_ID_MISSING', 'spec.object_id is missing'));
  }
  if (!nonEmptyString(spec.name)) {
    warnings.push(issue('SPEC_NAME_MISSING', 'spec.name is missing'));
  }
  if (!isFiniteNumber(spec.width) || spec.width <= 0 || !isFiniteNumber(spec.height) || spec.height <= 0) {
    warnings.push(issue('SPEC_SIZE_INVALID', 'spec width/height must be positive finite numbers', {
      width: spec.width,
      height: spec.height,
    }));
  }
  if (!hasValidRect(spec.rect)) {
    warnings.push(issue('SPEC_RECT_INVALID', 'spec.rect is missing or malformed'));
  }
  if (all.length === 0) {
    warnings.push(issue('SPEC_EMPTY', 'spec has neither layers nor groups'));
  }
  if (nodes.duplicateIds > 0) {
    warnings.push(issue('SPEC_DUPLICATE_OBJECT_ID', 'spec contains duplicate layer object_ids', {
      duplicateIds: nodes.duplicateIds,
    }));
  }
  if (nodes.badRects > 0) {
    warnings.push(issue('SPEC_BAD_RECT', 'spec contains layers with malformed rect', {
      badRects: nodes.badRects,
    }));
  }
  if (nodes.orphanParents > 0) {
    warnings.push(issue('WARN_ORPHAN_PARENT', 'some layer parent_ids are not present in the spec', {
      orphanParents: nodes.orphanParents,
    }));
  }
  return report(
    {
      layers: layers.length,
      groups: groups.length,
      css: cssCount,
      exportables: nodes.exportables,
      duplicateIds: nodes.duplicateIds,
      badRects: nodes.badRects,
      orphanParents: nodes.orphanParents,
    },
    warnings,
  );
}

export function inspectManifest(manifest: SliceManifest): IntegrityReport {
  const warnings: IntegrityIssue[] = [];
  const items = Array.isArray(manifest) ? manifest : [];
  let exportables = 0;
  let missingUrl = 0;
  let badRect = 0;
  let withByteHint = 0;
  const keys = new Map<string, number>();
  for (const item of items) {
    if (!nonEmptyString(item?.object_id)) {
      warnings.push(issue('SLICE_OBJECT_ID_MISSING', 'slice item has no object_id'));
    }
    if (!Array.isArray(item?.exportables)) {
      warnings.push(issue('SLICE_EXPORTABLES_INVALID', 'slice item has no exportables array', {
        objectId: item?.object_id,
      }));
      continue;
    }
    if (!hasValidRect(item.rect)) badRect += 1;
    for (const e of item.exportables) {
      exportables += 1;
      if (!nonEmptyString(e?.screenshot?.url)) missingUrl += 1;
      const length = e?.screenshot?.length;
      const size = e?.screenshot?.size;
      if ((isFiniteNumber(length) && length > 0) || (isFiniteNumber(size) && size > 0)) withByteHint += 1;
      const key = `${item.object_id}|${e?.format ?? ''}|${e?.scale ?? ''}`;
      keys.set(key, (keys.get(key) ?? 0) + 1);
    }
  }
  let duplicateExports = 0;
  for (const count of keys.values()) if (count > 1) duplicateExports += count - 1;
  if (items.length === 0) {
    warnings.push(issue('SLICE_MANIFEST_EMPTY', 'slice manifest is empty'));
  }
  if (missingUrl > 0) {
    warnings.push(issue('SLICE_URL_MISSING', 'some exportables have no screenshot.url', { missingUrl }));
  }
  if (badRect > 0) {
    warnings.push(issue('WARN_SLICE_RECT_INVALID', 'some slice items have malformed rect', { badRect }));
  }
  if (duplicateExports > 0) {
    warnings.push(issue('WARN_DUPLICATE_EXPORT', 'duplicate object_id/format/scale combinations', {
      duplicateExports,
    }));
  }
  return report(
    { items: items.length, exportables, missingUrl, withByteHint, duplicateExports, badRect },
    warnings,
  );
}

export function enforceIntegrity(report: IntegrityReport, code: IntegrityErrorCode): void {
  if (!report.ok || (config.integrityStrict && report.warnings.length > 0)) {
    throw new CodesignError(code, 'remote data failed integrity check', {
      issues: report.warnings,
      stats: report.stats,
      strict: config.integrityStrict,
    });
  }
}

export function integrityView(report: IntegrityReport): {
  ok: boolean;
  warnings: IntegrityIssue[];
  stats: Record<string, number>;
} {
  return { ok: report.ok, warnings: report.warnings, stats: report.stats };
}
