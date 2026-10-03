import type { Application } from '@needware/ir-types/Application';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { Value } from '@needware/ir-types/Value';
export interface PackageInfo { application: Application; digest: string; signers: string[] }
export interface LibraryEntry { id: string; title: string; digest: string; bytes: Uint8Array; state: string; generation: number; consent: boolean }
export type Command =
  | { kind: 'example' }
  | { kind: 'inspect'; bytes: Uint8Array }
  | { kind: 'library' }
  | { kind: 'load'; bytes: Uint8Array; consent: true }
  | { kind: 'dispatch'; action: string; values: Record<string, Value> }
  | { kind: 'delete'; id: string }
  | { kind: 'export-state' };
export interface WorkerReply { id: number; ok: boolean; data?: unknown; error?: string }
export interface Loaded { info: PackageInfo; view: ViewNode; storage: string }
export function frameEvent(value: unknown): value is { action: string; values: Record<string, Value> } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.action === 'string' && v.action.length <= 64 && !!v.values && typeof v.values === 'object' && !Array.isArray(v.values) && Object.keys(v.values).length <= 128;
}
