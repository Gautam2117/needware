declare module 'needware-wasm-runtime' {
  export default function init(input?: { module_or_path?: string }): Promise<unknown>;
  export function authored_example(): Uint8Array;
  export function inspect_package(bytes: Uint8Array): string;
  export class BrowserRuntime {
    constructor(bytes: Uint8Array, state: string | undefined, consent: boolean);
    view(): string;
    snapshot(): string;
    dispatch(event: string): string;
    restore(state: string): void;
    free(): void;
  }
}
