# Explicit canonical generation

The private Rust gateway defaults to `NEEDWARE_APPLICATION_FORMAT=wire`, using
the acyclic provider schema. Set `NEEDWARE_APPLICATION_FORMAT=canonical` only
with `NEEDWARE_PROVIDER=local` and an approved HTTPS OpenAI-compatible endpoint.
Unknown formats and incompatible provider kinds fail configuration. The name
`local` identifies the custom HTTP adapter; it does not establish local inference
or free service.

Canonical mode supplies the mechanically generated application schema in the
prompt and requests JSON-object output. The native compiler parses the response
with the existing strict 2 MiB IR parser, rejecting duplicate keys and unknown
fields. Canonical applications pass through the existing wire encoding and
decoding bounds before static validation, independent acceptance, generated
behavioral tests and package signing. JSON-object output alone does not establish
a valid application. Repair attempts, token and cost ceilings, cancellation and
deadlines still apply.

For Cloudflare's `@cf/openai/gpt-oss-120b`, this mode requests low reasoning effort.
This is a compatibility setting, not a model-quality guarantee. Each generated
test starts from default state and dispatches one action; independent acceptance
must cover repeated actions and the visible behavior required by the user.

Keep hosted generation disabled until the exact deployed compiler, approved
provider disclosure, durable account quotas, global free allowance, worker
readiness and public account acceptance pass. A successful synthetic counter or
an imported package in a frontend preview does not establish production readiness
or quality across application types. No paid fallback is authorized for the free
beta.

The current direct Cloudflare qualification remains incomplete: one bounded
native counter trial reached definition validation and was rejected; another
hit the existing provider deadline with unknown usage. Earlier acceptance of a
real model package through a private format adapter and three preview browser
engines does not qualify this direct connection. Do not enable hosted generation
on that evidence or automatically retry unknown-usage failures.
