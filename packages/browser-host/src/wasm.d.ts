declare module 'needware-wasm-runtime' {
  export default function init(input?: { module_or_path?: string }): Promise<unknown>;
  export function authored_example(): Uint8Array;
  export function authored_sync_example(): Uint8Array;
  export function inspect_package(bytes: Uint8Array): string;
  export class BrowserRuntime {
    constructor(bytes: Uint8Array, state: string | undefined, consent: boolean);
    view(): string;
    snapshot(): string;
    dispatch(event: string): string;
    restore(state: string): void;
    preview_revision(bytes: Uint8Array, consent: boolean): string;
    approve_revision(review: string, destructive: boolean, permissions: boolean): BrowserRuntime;
    free(): void;
  }
  export class BrowserVault {
    constructor(account: string | undefined);
    static from_local_backup(bytes: Uint8Array): BrowserVault;
    local_backup(): Uint8Array;
    device_public(): string;
    enrolled(): boolean;
    account_context(): string;
    account_authority(): string;
    device_certificate(): string;
    account_operation(nonce: string, operation: string, digest: string): string;
    approve_device(recipient: string, approved: boolean): string;
    accept_enrollment(enrollment: string, context: string, pin: string): void;
    create_recovery(approved: boolean): string;
    recover(code: string, envelope: string, context: string, pin: string): void;
    start_document(bytes: Uint8Array, instance: string, scope: string, epoch: number, consent: boolean): BrowserSync;
    document_key_backup(document: string): string;
    held_document_key_backup(document: string): string;
    has_document(document: string): boolean;
    forget_document(document: string): void;
    open_document_payload(document: string, bytes: Uint8Array, metadata: string): Uint8Array;
    own_document_membership(document: string, generation: number): string;
    accept_document_key(offer: string, expected: string, ownerEpoch: number, pin: string, generation: number, consent: boolean): void;
    restore_held_document_key(backup: string, context: string): void;
    restore_document_key(backup: string, context: string): void;
    open_document(bytes: Uint8Array, document: string, scope: string, epoch: number, generation: number, consent: boolean): BrowserSync;
    open_shared_document(bytes: Uint8Array, document: string, membership: string, ownerEpoch: number, pin: string, generation: number, scope: string, schemaEpoch: number, consent: boolean): BrowserSync;
    offer_document(document: string, certificate: string, context: string, authority: string, write: boolean, approved: boolean): string;
    join_document(bytes: Uint8Array, offer: string, context: string, rootEpoch: number, pin: string, generation: number, scope: string, epoch: number, consent: boolean): BrowserSync;
    free(): void;
  }
  export class BrowserSync {
    fork_session(): BrowserSync;
    seal_payload(bytes: Uint8Array, metadata: string): Uint8Array;
    open_payload(bytes: Uint8Array, metadata: string): Uint8Array;
    binding(): string;
    membership(): string;
    snapshot(): string;
    view(): string;
    restore_local_state(state: string): void;
    verify_package(bytes: Uint8Array): void;
    set_roster(roster: string): void;
    known(): string;
    export(known: string): string;
    checkpoint(): string;
    receive(frame: string): number;
    dispatch(event: string): string;
    free(): void;
  }
}
