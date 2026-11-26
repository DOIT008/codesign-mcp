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
    if (value == null) continue;
    lines.push(`${key}: ${summarizeValue(value)}`);
  }
  lines.push('Full data is available in structuredContent.');
  return lines.join('\n');
}

export function toolSuccess(payload: Record<string, unknown>, includeFullText = false): ToolResult {
  const structuredContent = { ok: true, ...payload };
  return {
    structuredContent,
    content: [{
      type: 'text',
      text: includeFullText ? JSON.stringify(structuredContent) : summarizePayload(structuredContent),
    }],
  };
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
