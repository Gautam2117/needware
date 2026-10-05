# Registry, stable links and independent remix

Registry entries have stable random UUID URLs at `/a/<id>`. The current revision
may change through owner-authorized compare-and-swap publication. Exact revision
URLs include the immutable package digest. Existing signed revisions cannot be
overwritten. Successors must name the exact signed parent and keep application
identity; switching visibility cannot substitute a different revision.

Private entries point to owned, ready encrypted relay documents. The server does
not receive or expose their plaintext definitions. Only the owner discovers the
entry; opening its document still requires vault keys and a current grant.
Private registry discovery does not grant collaborator access. Unlisted entries
are excluded from discovery and available to anyone with the exact link. Public
entries are discoverable. Public/unlisted publication requires deliberate upload
of the definition and assets, with disclosure that downloaded copies cannot be
erased by later visibility changes. Runtime state is never part of the package.

The server independently runs the native Rust package/signature/schema validator
through WASM before accepting plaintext publication. It retains verified package
metadata and bounded immutable bytes. Consumer opening pins the requested digest
and requires signer/permission review before execution in the isolated frame.
Private redirects never expose plaintext package downloads. Every download
rechecks current visibility; responses are uncached. Writes require verified
accounts, exact origin, bounded canonical JSON and ownership. Advisory locks and
CAS enforce count/storage/revision quotas under concurrent publication. Current
revision foreign keys are deferred inside publication, preventing dangling
entries and cascading private-document/account deletion.

Native remix verifies the source, copies only the definition and verified assets,
assigns independent application/revision IDs, clears source migrations and signs
the exact source digest as its parent. It creates a new signer explicitly shown
for review. Runtime data, document keys and collaborator grants never enter the
copy. Published lineage requires an existing visible source revision and the
signed source parent. Subsequent revisions retain lineage through their signed
parent chain. Deleting a source removes its URL reference but retains the source
digest. Remix creates an independent application; it grants no access to the
original document or its data.

Limits are 4 MiB per published package, 32 revisions per entry, 256 entries and
128 MiB of definition storage per account. Anonymous discovery/downloads use
database-backed request and byte budgets. Caller forwarding headers never choose
the limit identity. Only configured Vercel ingress is trusted; other ingress
shares a conservative budget until an explicit trusted adapter is implemented.
Billing-aware storage quotas and operator moderation belong to later milestones.

`pnpm test:registry` exercises real independent accounts, native server
verification, visibility/ownership/auth/origin/canonical/CAS boundaries, immutable
revision downloads, consumer publication/open/remix, signed lineage, request/byte
limits and deletion cascades in disposable PostgreSQL. `remix.spec.ts` verifies
consent, tamper rejection, unchanged permissions, independent identities/signers,
source preservation and absence of copied runtime data in three browser engines.
