// 统一的工具返回构造。
// 默认只在 content[0].text 放一行摘要，完整数据放在 structuredContent，
// 避免同一份 JSON 在 LLM 上下文里出现两遍。老客户端如果不读
// structuredContent，可以传 includeFullText=true 拿完整文本（无缩进）。

import { isCodesignError } from '../codesign/errors.js';
import type { ToolResult } from './server.js';

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function summarizeValue(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const arrays = entries
      .filter(([, item]) => Array.isArray(item))
      .map(([key, item]) => `${key}: ${(item as unknown[]).length}`);
    return arrays.length > 0
      ? `{${entries.length} fields; ${arrays.join(', ')}}`
      : `{${entries.length} fields}`;
  }
  if (typeof value === 'string' && value.length > 120) return `"${value.slice(0, 117)}..."`;
  return String(value);
}

export function summarizePayload(payload: Record<string, unknown>): string {
  const lines: string[] = [payload.ok === false ? 'failed' : 'ok'];
  for (const [key, value] of Object.entries(payload)) {
    if (value == null || key === 'ok') continue;
    lines.push(`${key}: ${summarizeValue(value)}`);
  }
  lines.push('Full data is available in structuredContent.');
  return lines.join('\n');
}

export function toolSuccess(
  payload: Record<string, unknown>,
  includeFullText = false,
  summarizer: (payload: Record<string, unknown>) => string = summarizePayload,
): ToolResult {
  const structuredContent = { ok: true, ...payload };
  return {
    structuredContent,
    content: [{
      type: 'text',
      text: includeFullText ? JSON.stringify(structuredContent) : summarizer(structuredContent),
    }],
  };
}

interface HierarchyNodeLike {
  name: string;
  type: string;
  rect: { width: number; height: number };
  children?: HierarchyNodeLike[];
}

// get_artboard_spec 的文本摘要：保留两层层级骨架与完整性告警，
// 让不读 structuredContent 的客户端也能看到还原必需的结构信息。
export function summarizeSpecPayload(payload: Record<string, unknown>): string {
  const lines: string[] = [payload.ok === false ? 'failed' : 'ok'];
  for (const [key, value] of Object.entries(payload)) {
    if (value == null || key === 'ok') continue;
    if (key === 'spec') {
      lines.push(...summarizeSpec(value));
    } else if (key === 'selection') {
      lines.push(...summarizeSelection(value));
    } else if (key === 'integrity') {
      lines.push(summarizeIntegrity(value));
    } else {
      lines.push(`${key}: ${summarizeValue(value)}`);
    }
  }
  lines.push('Full data is available in structuredContent.');
  return lines.join('\n');
}

function summarizeSpec(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [`spec: ${summarizeValue(value)}`];
  const spec = value as {
    artboard?: { name?: string; width?: number; height?: number };
    hierarchy?: HierarchyNodeLike[];
    layers?: unknown[];
    groups?: unknown[];
    slices?: unknown[];
  };
  const lines: string[] = [];
  const artboard = spec.artboard;
  if (artboard) {
    lines.push(`artboard: ${artboard.name ?? '?'} (${artboard.width ?? '?'}x${artboard.height ?? '?'})`);
  }
  lines.push(...summarizeHierarchy(spec.hierarchy));
  lines.push(
    `spec: layers: ${spec.layers?.length ?? 0}, groups: ${spec.groups?.length ?? 0}, slices: ${spec.slices?.length ?? 0}`,
  );
  return lines;
}

function summarizeSelection(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [`selection: ${summarizeValue(value)}`];
  const selection = value as {
    scope?: string;
    rootName?: string;
    nodeCount?: number;
    layerCount?: number;
    groupCount?: number;
    hierarchy?: HierarchyNodeLike[];
  };
  return [
    `selection: ${selection.scope ?? '?'} root=${selection.rootName ?? '?'} nodes=${selection.nodeCount ?? 0} (layers ${selection.layerCount ?? 0}, groups ${selection.groupCount ?? 0})`,
    ...summarizeHierarchy(selection.hierarchy),
  ];
}

function summarizeHierarchy(hierarchy: HierarchyNodeLike[] | undefined): string[] {
  if (!Array.isArray(hierarchy) || hierarchy.length === 0) return [];
  const lines: string[] = [`hierarchy (top levels):`];
  let visited = 0;
  const walk = (nodes: HierarchyNodeLike[], depth: number): void => {
    for (const node of nodes) {
      if (visited >= 40) return;
      if (depth < 2) {
        const size = node.rect ? `${node.rect.width}x${node.rect.height}` : '?';
        lines.push(`${'  '.repeat(depth)}- ${node.name} [${node.type}] ${size}`);
      }
      visited += 1;
      if (Array.isArray(node.children)) walk(node.children, depth + 1);
    }
  };
  walk(hierarchy, 0);
  if (visited > 40) lines.push('  ... (truncated)');
  return lines;
}

function summarizeIntegrity(value: unknown): string {
  if (!value || typeof value !== 'object') return `integrity: ${summarizeValue(value)}`;
  const integrity = value as { ok?: boolean; warnings?: unknown[]; stats?: unknown };
  if (Array.isArray(integrity.warnings) && integrity.warnings.length > 0) {
    const preview = integrity.warnings.slice(0, 3).map((item) => String(item)).join('; ');
    return `integrity: warnings=${integrity.warnings.length} (${preview})`;
  }
  return `integrity: ${integrity.ok === false ? 'failed' : 'ok'}`;
}

// 诊断记录本身就是给 LLM 阅读的内容，默认保留完整文本但不加缩进。
export function toolSuccessFull(payload: Record<string, unknown>): ToolResult {
  const structuredContent = { ok: true, ...payload };
  return {
    structuredContent,
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
  };
}

export function toolFailure(payload: Record<string, unknown>): ToolResult {
  const structuredContent = { ok: false, ...payload };
  return {
    isError: true,
    structuredContent,
    content: [{ type: 'text', text: summarizePayload(structuredContent) }],
  };
}

export function toolError(err: unknown): ToolResult {
  const error = isCodesignError(err)
    ? err.toJSON()
    : { code: 'INTERNAL', message: errMsg(err) };
  const structuredContent = { ok: false, error };
  return {
    isError: true,
    structuredContent,
    content: [{ type: 'text', text: `[${error.code}] ${error.message}` }],
  };
}
