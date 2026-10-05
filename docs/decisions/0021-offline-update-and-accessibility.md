# Offline updates and accessibility

The consumer shell reports whether its offline cache is ready, whether the browser
is connected and whether an update is waiting. Update checks are explicit. A new
worker does not call `skipWaiting`: users save their inputs or export recovery,
close all Needware tabs and reopen. An open application keeps its current worker
and signed runtime. Offline readiness still requires a controlling worker and
retries lost claim requests with a bounded deadline.

The installation manifest contains authored 192/512-pixel icons and a separate
maskable icon. Safari metadata includes the 180-pixel icon. All icons and the
favicon are included in the versioned offline cache. Local/encrypted/account
navigation requests full HTML instead of uncached router responses and retains
the existing unsaved-input guards. Private API responses remain outside the cache.

Horizontally scrolling tables, chart data and calendars have labeled, focusable
regions. Left/right arrows scroll a focused region consistently across engines;
events from nested controls and modified key combinations retain their behavior.
Narrow headers wrap, file inputs show keyboard focus and dark error text meets
the automated contrast check.

Acceptance uses axe-core's WCAG 2 A/AA, 2.1 A/AA and 2.2 AA rule tags without
rule exclusions. It covers five consumer pages, signed visual content in the
isolated frame, narrow and dark views, modal and drawer scopes. Screenshots and
rule results are attached to the browser report. Automated scans do not establish
complete WCAG conformance or replace assistive-technology/human acceptance.

Update acceptance installs an actual waiting worker while an unsaved input remains
usable, then saves through the old worker. Offline acceptance stops the actual
origin and verifies reload, cached icons and navigation. Chromium and Firefox also
use protocol offline mode. WebKit's protocol offline reload raises an engine error,
so its origin remains genuinely stopped while only `navigator.onLine` is simulated
to check the indicator. Installation and offline/update behavior on physical
Android/iOS devices remain unverified.
