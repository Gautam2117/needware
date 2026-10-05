# Complete declarative visual families

`visual_components_v1` adds the six remaining component families: icon, image,
table, tabs, chart and calendar. It also requires `declarative_widgets_v1` for
native value bindings. All 35 IR components now have a trusted renderer; native
validation, typed data and package authority remain mandatory.

Images bind to an exact digest in the verified package's signed asset manifest.
Package verification decodes only PNG/JPEG/WebP with 4096 by 4096 and 64 MiB
decode limits. Each view caps encoded raster output at 16 MiB and aggregate
raster pixels at 16,777,216 (64 MiB RGBA), including repeated compressed images.
Verified dimensions reserve layout space. The iframe makes
and revokes its own blob URLs; CSP permits blob images and denies remote images,
network connections and HTML form actions. Descriptions are required unless an
unactionable image explicitly declares `decorative`. Icons use nine trusted
glyphs with accessible descriptions, without external fonts or executable SVG.

Tables render at most the existing 100-record native collection cut, group cells
by their authenticated record identifiers, match headers to cell templates, and
retain native typed actions for each row. Empty collections have an explicit
message. Wide tables scroll inside their container on narrow screens.

Tabs have 1 to 32 distinct bounded labels and stable tab/panel references. Arrow
keys and Home/End move focus and selection; one tab is in the keyboard tab order.
Inactive panels are hidden while retaining draft state. Overlays belong outside
tab panels. Tab selection is transient presentation and does not mutate data.

Charts accept at most 100 records containing exactly a nonempty bounded label
and a canonical signed 64-bit integer. Integer arithmetic scales bars without
floating-point precision loss; the adjacent semantic table exposes exact signed
values. Empty charts have a clear message. Calendars accept a valid first-of-month
date from 1900 onward and at most 100 bounded labeled events within that month.
They use a semantic weekday table and canonical date cells. Both families reject
malformed data before a staged action or restore changes the existing cut.

Controlled tone/size and theme accent/density/radius influence trusted CSS.
Responsive and dark appearances keep table/chart text and focus indicators
available. Authored native and Chromium/Firefox/WebKit acceptance cover assets,
wrong/external digests, typed visual rejection and rollback, exact chart values,
calendar events, keyboard tabs, retained drafts, record actions, narrow layouts,
no external requests and cold reopen. This is component support, not unrestricted
chart types, remote image capability, a scheduling engine or human visual/device
acceptance. Effect completion, durable draft recovery, PWA update/recovery,
security/fuzz/benchmarks and real production integrations remain open.
