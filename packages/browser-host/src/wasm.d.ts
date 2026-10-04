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
    account_context(): string;
    account_authority(): string;
    device_certificate(): string;
    approve_device(recipient: string, approved: boolean): string;
    accept_enrollment(enrollment: string, context: string, pin: string): void;
    create_recovery(approved: boolean): string;
    recover(code: string, envelope: string, context: string, pin: string): void;
    start_document(bytes: Uint8Array, instance: string, scope: string, epoch: number, consent: boolean): BrowserSync;
    document_key_backup(document: string): string;
    restore_document_key(backup: string, context: string): void;
    open_document(bytes: Uint8Array, document: string, scope: string, epoch: number, generation: number, consent: boolean): BrowserSync;
    offer_document(document: string, certificate: string, context: string, authority: string, write: boolean, approved: boolean): string;
    join_document(bytes: Uint8Array, offer: string, context: string, rootEpoch: number, pin: string, generation: number, scope: string, epoch: number, consent: boolean): BrowserSync;
    free(): void;
  }
  export class BrowserSync {
    binding(): string;
    membership(): string;
    snapshot(): string;
    view(): string;
    set_roster(roster: string): void;
    known(): string;
    export(known: string): string;
    checkpoint(): string;
    receive(frame: string): number;
    dispatch(event: string): string;
    free(): void;
  }
}
