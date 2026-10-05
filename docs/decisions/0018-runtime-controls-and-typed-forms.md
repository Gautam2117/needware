# Runtime controls and typed forms

`runtime_controls_v1` declares navigation/back and modal/drawer behavior.
Navigation keeps the latest 128 screens; back at the oldest retained screen
fails without changing application data. Navigation closes overlays. At most
four overlays can be open; only the top overlay is interactive. Overlays are
outside repeated collection templates and must declare their own close action.
Their trusted close action cannot be disabled.

Action sequences stage data, navigation, history and overlays together. A failed
action preserves the complete cut. Opaque WASM savepoints bind to one runtime
instance and allow the host to restore the same cut after rendering, effect or
persistence failure. Savepoints cannot be constructed from serialized input.
Controls are transient and start at the initial screen after cold reopen.

`declarative_widgets_v1` adds optional expression bindings `value` and `disabled`,
typed form controls, and integer progress from 0 to 100. Omitted bindings retain
legacy package serialization. Older runtimes reject unknown required features
before activation. Disabled controls are presentation; native event contracts
and scoped capability authorization remain the authority for actions.

Each form declares a typed submit action. Its inputs have distinct field names
from that exact event contract. Forms cannot be nested; repeated forms belong
inside their record container. The renderer supplies `record_id`. Boolean,
enum, enum-list, date, UTC datetime, integer and fixed-scale decimal controls
preserve native types. Sliders have a bound value and an integer range within
signed 32-bit limits, with at most one million steps. Exact decimal inputs use
text and a numeric keyboard hint instead of browser floating-point conversion.
Invalid projections reject the staged action before committing data or controls.

Form buttons and Enter in single-line inputs send typed messages through the
existing private channel. They do not perform HTML form submission. The iframe
keeps `sandbox="allow-scripts"`, no network access and `form-action 'none'`.
Modal focus, keyboard containment, Escape and opener restoration work across
Chromium, Firefox and WebKit. Dialogs and drawers fit narrow viewports.

Drafts are scoped to each form and record. A saved-value change preserves a
dirty draft and blocks submission until the user chooses the saved value or
keeps the draft. Invalid editing cannot replay an earlier valid value. Clean
offscreen bindings are released; dirty drafts survive in-frame navigation.
Draft storage is bounded to 4 MiB and 4,096 fields; exceeding it preserves the
existing draft and reports a limit. Drafts are transient browser UI state, not
durable application edits. Closing/replacing the iframe discards drafts; a
host-level unsaved-draft warning and recovery/export remain pending.

Authored native and three-browser acceptance cover nested navigation, history
bounds, atomic failure, exact-instance rollback, declared overlay constraints,
focus/Escape/drawer closure, exact decimals above JavaScript integer precision,
independent forms, saved-value conflicts, invalid decimal editing, export and
cold reopen. Full renderer coverage, effect completion, PWA update/recovery UX,
real provider/billing configuration and production/device acceptance remain open.
