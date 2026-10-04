import type { Value } from '@needware/ir-types/Value';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { PackageInfo } from './protocol';
export type EncryptedCommand = { account: string } & (
  | { kind: 'list' }
  | { kind: 'example' }
  | { kind: 'inspect'; bytes: Uint8Array }
  | { kind: 'create'; bytes: Uint8Array; consent: true }
  | { kind: 'open'; document: string; consent: true }
  | { kind: 'dispatch'; instance: string; action: string; values: Record<string, Value> }
  | { kind: 'export-package'; instance: string }
  | { kind: 'export-state'; instance: string }
  | { kind: 'delete'; document: string }
);
export interface EncryptedEntry { document: string; info: PackageInfo }
export interface EncryptedLoaded extends EncryptedEntry { instance: string; view: ViewNode; pendingUploads: number }
