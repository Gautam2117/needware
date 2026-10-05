# Durable typed external effects

`typed_effects_v1` requires `typed_contracts_v1`. `AwaitEffect` declares a scoped
capability, bounded input expression, output Field and success/failure callbacks.
The request captures original validated event values. Successful outcomes add a
validated `result`; failures add a bounded lowercase `error` code. Those names
are reserved. Completion callbacks may change application data with declarative
transactions, but cannot trigger another external effect or navigate the UI.

Preparing a request cannot commit mixed data mutations. A native intent binds
its verified signed package digest, execution scope and exact state cut. The
scope of encrypted execution is the actual document/epoch binding. Completion
rechecks that cut, the capability grant, output contract, resulting state and
complete projected view before committing data and consuming the intent once.
Invalid outputs, changed state, failed projection and failed replica writes leave
the original intent/data intact. Runtime savepoints retain intents and scope.

Native checkpoints hold at most four intents and serialize to at most 2 MiB,
including all captured event values and callback declarations. The exact envelope
is checked before publication, so every accepted checkpoint fits the strict JSON
decoder. Cold restore re-derives each request and callback from its verified signed
action and captured event; changing its payload, callback, package, scope, cut or
identity rejects atomically. A rejected restore never executes an external action.

The encrypted browser host supports one unresolved request at a time. Its bounded
8 MiB private intent record stays inside the existing encrypted account-root/CAS
journal and does not enter sync frames or hosted generation storage. The host
persists `prepared`, then `dispatching` before calling a broker, then the known
result before applying the signed callback. Failed writes prevent the next step.
A failed callback commit retains the durable result for application again without
calling the external service. A returned result that cannot yet be persisted stays
in the open trusted shell, is available to explicit plaintext export, and guards
application replacement/deletion and page unload against silent loss. The retry
saves/applies that known result and never invokes the clipboard again. Unknown dispatched outcomes cannot replay after a
reload, timeout or crash. Changed document/package/epoch cuts retain requests and
results for review, and do not block cold document opening or overwrite new data.
Removing an old intent writes no old-epoch frame.

The first trusted-shell broker supports clipboard **writing only**, with string
input up to 65,536 code units and a signed string output contract. It shows the
content, durably authorizes the request, and then requires a separate fresh button
click before invoking the browser API. A success returns the copied text; denial
returns `clipboard_denied`. The renderer iframe cannot invoke this broker or post
completion outcomes. Explicit plaintext export preserves the source binding,
request and known outcome; it requires confirmation and excludes unrelated
application state. Clipboard reads, other external capabilities and local-library
execution remain unavailable until their brokers and persistence are implemented.

Verification: six native tests cover atomic one-time completion, savepoints,
missing grants, mixed mutation rejection, stale state/scope, signed cold restore,
tampering, prohibited callbacks and aggregate checkpoint bounds. Nine browser
cases across Chromium, Firefox and WebKit cover actual encrypted journal commits,
failed intent/result/completion persistence, unrecorded-result export and guarded
application deletion, cross-document rejection, cold recovery, malformed outputs,
unknown-outcome replay denial, explicit clipboard gestures and denied-operation
callbacks. Browser clipboard calls use controlled fixtures; they do not prove
physical OS clipboard behavior. Sanitizer invariants also exercise checkpoint
restore and typed completion. Full regression and exact-commit CI receipts are
recorded in the session anchor and project status after completion.

Real provider/network/file/device brokers, provider quality, production credentials,
deployment, exact-device clipboard/PWA/accessibility and human acceptance remain
open. This decision does not claim overall product completion.
