import type { Value } from '@needware/ir-types/Value';
import type { ViewNode } from '@needware/ir-types/ViewNode';
import type { PackageInfo, RevisionReport } from './protocol';
export type EncryptedCommand = { account: string } & (
  | { kind: 'list' }
  | { kind: 'example' }
  | { kind: 'inspect'; bytes: Uint8Array }
  | { kind: 'generation-recipient' }
  | { kind: 'preview-generation'; job: string }
  | { kind: 'create'; bytes: Uint8Array; consent: true }
  | { kind: 'open'; document: string; consent: true }
  | { kind:'effect-review'; instance:string }
  | { kind:'begin-effect'|'finish-effect'|'discard-effect'; instance:string; id:string }
  | { kind:'record-effect'; instance:string; id:string; outcome:unknown }
  | { kind: 'dispatch'; instance: string; action: string; values: Record<string, Value> }
  | { kind: 'select-page'; instance: string; node: string; offset: number }
  | { kind: 'save-drafts'; instance:string; id:string; digest:string; drafts:unknown }
  | { kind: 'draft-summaries'; instance:string }
  | { kind: 'load-draft'; instance:string; source:number; id:string; generation:number }
  | { kind: 'forget-draft'; instance:string; id:string; generation:number }
  | { kind: 'export-package'; instance: string }
  | { kind: 'export-state'; instance: string }
  | { kind: 'delete'; document: string }
  | { kind: 'sync'; instance: string }
  | { kind: 'rotate-epoch'; instance: string; consent: true; retained?: {certificate:string;write:boolean}[] }
  | { kind: 'epoch-recipients'; instance: string }
  | { kind: 'cancel-epoch'; instance: string }
  | { kind: 'epoch-state'; instance: string }
  | { kind: 'preview-shared-revision'; instance: string; bytes: Uint8Array }
  | { kind: 'publish-shared-revision'; instance: string; digest: string; destructive: boolean; permissions: true; retained?: {certificate:string;write:boolean}[] }
  | { kind: 'cancel-shared-revision'; instance: string }
  | { kind: 'recovery-history'; instance: string }
  | { kind: 'cloud-list' }
  | { kind: 'preview-cloud'; document: string; pin?: string; ownerEpoch?: number; consent: true }
  | { kind: 'accept-cloud'; document: string; consent: true; preserveOffline?: boolean }
  | { kind: 'cancel-cloud' }
  | { kind: 'collaboration-identity' }
  | { kind: 'share'; instance: string; certificate: string; write: boolean; consent: true }
);
export interface SharedRevisionReview { review_digest: string; runtime: RevisionReport; package_digest: string; signers: string[]; scope: unknown }
export interface OfflineReview { pending: number; state: string }
export interface EncryptedEntry { document: string; info: PackageInfo; offline?: OfflineReview }
export interface EncryptedLoaded extends EncryptedEntry { instance: string; view: ViewNode; pendingUploads: number; cloudEnabled: boolean; epochPending?: boolean; isOwner?: boolean; reviewRequired?: boolean }
export interface CloudEntry { id: string; binding: { document: { account: string; document: string } }; ready: boolean }
export interface EpochRecipientChoice { device_id:string;account_id:string;label:string;certificate:unknown;membership?: {role:string} }
