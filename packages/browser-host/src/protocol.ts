import type { Application } from '@needware/ir-types/Application';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { Value } from '@needware/ir-types/Value';
import type { RevisionReport } from '@needware/ir-types/RevisionReport';
export type { RevisionReport };
export interface PackageInfo { application: Application; digest: string; signers: string[] }
export interface LibraryEntry { id: string; title: string; digest: string; bytes: Uint8Array; state: string; generation: number; consent: boolean }
export type Command =
  | { kind: 'example' }
  | { kind: 'inspect'; bytes: Uint8Array }
  | { kind: 'remix'; bytes: Uint8Array; application: string; revision: string; consent: true }
  | { kind: 'library' }
  | { kind: 'load'; bytes: Uint8Array; consent: true }
  | { kind: 'preview-revision'; bytes: Uint8Array; consent: true }
  | { kind: 'activate-revision'; review: string; destructive: boolean; permissions: boolean }
  | { kind: 'history'; id: string }
  | { kind: 'rollback'; id: string; snapshot: number; expected: number; consent: true }
  | { kind: 'dispatch'; instance: string; action: string; values: Record<string, Value> }
  | { kind: 'delete'; id: string }
  | { kind: 'export-state' };
export interface WorkerReply { id: number; ok: boolean; data?: unknown; error?: string; retryAfter?: number; status?: number }
export interface Loaded { instance: string; info: PackageInfo; view: ViewNode; storage: string }
export function frameEvent(value: unknown): value is { action: string; values: Record<string, Value> } {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.action === 'string' && v.action.length <= 64 && !!v.values && typeof v.values === 'object' && !Array.isArray(v.values) && Object.keys(v.values).length <= 128;
}
