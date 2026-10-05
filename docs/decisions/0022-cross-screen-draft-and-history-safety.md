# Cross-screen draft and history safety

Native views separate event input fields from fields eligible for a durable success
acknowledgment. Navigation/back/open/close actions never acknowledge drafts, even
when a declared input contract supplies values for the control action. Legacy
actions without schemas retain their exact expression input fields. Atomic write
groups combine acknowledged fields; conditionals conservatively retain fields
that cannot be proven accepted on every branch. Normal native value bindings can
still reconcile an input with its actual saved value.

Input metadata is derived once from the verified package. Each action has at most
128 fields, matching the legacy event bound. Rendering charges request and
acknowledgment metadata before cloning, with a 4 MiB aggregate bound. A repeated
wide-action fixture verifies bounded projection while all saved records remain
unchanged. These changes affect transient views, not encrypted state or epochs.

Legacy inputs outside explicit forms use the native screen and record identity.
The renderer retains dirty inputs by their full scope, field and node identity
when another node occupies the same slot. Two current inputs with one field name
block ambiguous submission and keep both raw drafts exportable. Closed or absent
inputs cannot supply a hidden draft to a current action. Draft counts, editing
limits and exports include retained inputs. Only actual input components are
eligible for recovery.

Recovery validates the entire file and rejects duplicate node/field identities
before importing anything. If fields span screens, no subset imports automatically.
Users explicitly recover the current screen, review and save it, then open the next
screen. Remaining fields stay in the original recovery file; the preview reports
their count. The file is never modified or deleted. Each selected import stages
atomically against the current native view. Exact older global/record scopes remain
accepted for the same native node/field, signed package and application/document.

Consumer links entering active applications use full HTML navigation. Application
links leaving them do likewise, allowing real browser Back/Forward traversals to
use the existing leave warning instead of destroying the isolated renderer through
a client-router traversal. Hosted generation rechecks current drafts when a result
is ready before leaving; cancelling leaves the result in creation history and the
inputs on screen. Approved navigation consumes one browser-warning bypass.

Acceptance reproduces prior navigation and duplicate-slot loss in all three engines,
then verifies independent text, ambiguous-write rejection, complete exports,
multi-screen explicit recovery, legacy file compatibility and actual browser
history traversal with dismissed/accepted leave dialogs. Automated history commands
use the real browser history API; they do not inject synthetic popstate events.
Plaintext recovery still requires explicit export. Mobile termination, crashes,
browser-suppressed warnings and durable encrypted draft storage remain open.

Encrypted journal acceptance additionally verifies screen/history and open-overlay
preservation under injected durable-store failure in Chromium, Firefox and WebKit.
The existing whole-runtime fork already preserves controls; no crypto or journal
implementation change was necessary. The authored test package declares its
synchronized-storage and collaboration permissions explicitly.
