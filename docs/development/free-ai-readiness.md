# Free inference research and layered diagnostics

Checked 2026-10-06. This is measured compatibility evidence and an enablement
gate, not a claim of unlimited inference or production generation readiness.
Owner-provided credentials remain in private ignored files. They are never
committed, passed in CLI arguments, or uploaded with the host probe.

## Current candidates

| Provider | Recurring allowance and constraints | Needware decision |
| --- | --- | --- |
| Cloudflare Workers AI | Actual account shows Workers Free ($0), including 10,000 neurons daily; exhaustion needs an explicit paid upgrade. Model-specific rates apply. Some newer models require paid billing. | Restricted token authenticated; GPT-OSS 120B intent extraction passed. Full generation remains unverified. No AI Gateway paid/unified billing fallback or production enablement. |
| Mistral | Actual Free account displays $10 included monthly API usage, pay-as-you-go off. Small/Medium show 20K TPM / 1 RPS. API training disabled; Labs off. | Authentication/model listing passed, but both bounded inference attempts returned HTTP 429/code 1300 before generation. Cause unresolved. Production suitability and retention remain unverified; no billion-token allowance established. |
| OpenRouter | No-purchase free quota is 20 RPM / 50 requests daily; underlying free pools can throttle sooner. | Real calls authenticated and cost zero on fixed Novita zero-retention routes, but generation failed; do not enable production. |
| Groq | Actual account: 8K TPM / 200K TPD / 1K daily requests; observed separate 1K output TPM restriction. | Real trials produced no accepted package. Retain as a candidate, not a proven generator. |
| Hugging Face | Free users receive $0.10 monthly experiment credit, subject to change. | Too small to underpin public generation. No credit purchases. |
| DeepSeek direct | Metered inference deducts granted or purchased balances. Owner account has no granted balance. | Disabled: inference would consume purchased credit, conflicting with strict $0. |
| Cerebras | Current trial requires a verified payment method; $5 expires after 30 days, no permanent free tier. | Reject for recurring $0 launch. Older free-tier directories are stale. |
| Gemini unpaid | Model-specific quotas; unpaid content may improve products under its terms. | Exclude from private user-prompt routing under the current privacy policy. |
| Device-local open models | No central API quota; hardware, memory, downloads and licenses still constrain use. | Optional future privacy route. This Mac has 16 GB RAM and Ollama, but no installed model. No phone compatibility or flagship-quality claim. |

Official sources: [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[Cloudflare data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/),
[Mistral limits](https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them),
[Mistral API opt-out](https://help.mistral.ai/en/articles/455207-can-i-opt-out-of-my-input-or-output-data-being-used-for-training),
[OpenRouter limits](https://openrouter.ai/docs/api-reference/limits),
[OpenRouter provider policies](https://openrouter.ai/docs/guides/privacy/provider-logging),
[OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr),
[Hugging Face pricing](https://huggingface.co/docs/inference-providers/pricing),
[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/),
[Cerebras trial policy](https://inference-docs.cerebras.ai/support/rate-limits),
[Gemini terms](https://ai.google.dev/gemini-api/terms).

Discovery included the [Free-LLM directory](https://github.com/nejib1/Free-LLM)
and the [Mistral billion-token report](https://zenn.dev/sioois/articles/dea773011514b1?locale=en).
Directories and forum claims are leads, not authority for pricing, privacy,
commercial suitability or this account's quota. No leaked credentials,
multi-account quota evasion, referral abuse or unauthorized proxies are used.

## Account checks and measured provider trials

The authenticated Mistral model list returned HTTP 200. Small 2603 and Medium
2604 were available; Large 2512 was absent despite appearing on the limits page.
An isolated synthetic counter trial used Small for intent and Medium for
generation/repair, with four calls maximum and the unchanged Rust validator.
The first intent call returned HTTP 429/code 1300. A second bounded trial with
a 512-token intent cap and request spacing also returned that error. Neither
produced a package; both exited nonzero. Account usage still showed zero
requests and $0. No billing or training setting was enabled to bypass this.
Private receipts: `.local/mistral-results/1791286677515/benchmark.json` and
`.local/mistral-results/1791286853721/benchmark.json`.

Cloudflare's authenticated Workers plan page confirms Free is the current plan
at $0, with 10,000 AI neurons/day. Workers listed zero requests and no projects.
The owner created the prepared token granting only Workers AI Read to the
selected account, expiring October 13. Authentication passed. A real GPT-OSS
120B intent request returned HTTP 200, reporting 347 tokens and 19.186 neurons;
the account dashboard showed 19.19/10K daily neurons used before later trials.
The following app-generation request exceeded the diagnostic's 55-second
transport timeout; no package was produced. This does not establish poor model
quality or a validator rejection. Longer and JSON-object trials also stopped
at the native request deadline, without a complete definition response.
Existing domains and deployments were not changed. Free-plan verification does
not establish model quality, available remaining neurons or production readiness.

Real intent responses exposed two ambiguities: treating built-in UI as forbidden
executable code, and putting explanatory "none" strings in `unsupported`.
The compiler prompt now explains the declarative runtime and requires an empty
unsupported array when appropriate; the field's schema description reinforces
that rule. A real counter then passed intent extraction. A separate real request
for user-supplied/remote executable scripts still returned `unsupported_intent`,
with no package. No unsupported entries are filtered or silently reinterpreted.
Final script-rejection receipt: `.local/cloudflare-results/1791288573860/benchmark.json`.

The next measured layer used GPT-OSS 120B for intent and
`@cf/qwen/qwen3-30b-a3b-fp8` for generation and two repairs. JSON-object mode
finished in 32.252 seconds using 196.452 observed neurons; schema-constrained
mode finished in 51.885 seconds using 222.521 neurons. All upstream calls
returned HTTP 200 with token/neuron usage, but both produced zero signed
packages: invalid JSON, table references or definitions were rejected. These
are unsuccessful generation trials, not production acceptance. Private receipts:
`.local/cloudflare-results/1791288475862/benchmark.json` and
`.local/cloudflare-results/1791288556086/benchmark.json`.
See [GPT-OSS 120B](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/)
and [Qwen 30B](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/).

## Measured OpenRouter failures

Both fixed `apodex/apodex-1.1-mini:free` via `novita/bf16` and
`inclusionai/ling-3.0-flash-sante:free` via `novita` appeared in the current
zero-retention endpoint list with zero prompt/completion prices. Routing used
`only`, no fallback, required parameters, data collection denied, ZDR enabled
and maximum prompt/completion price zero. Successful responses reported Novita
and cost zero. These attestations do not independently prove provider privacy.

Apodex's advertised structured-output support did not match its live endpoint:
JSON Schema returned HTTP 400, supporting only JSON-object mode. An explicit
instance prompt allowed intent extraction, then counter generation/repairs
failed strict Rust decoding or truncated. Ling also extracted intent and tried
two repairs, but returned invalid definitions. Both later hit HTTP 429 from the
upstream shared pool, not exhaustion of the owner's 50-request daily allowance.
No counter, habit or contact trial produced an accepted signed package. The
diagnostic process exiting zero in earlier runs did not establish success.

A subsequent real layered counter trial made four zero-cost calls: Apodex
intent, Ling generation, and two Apodex repairs. All returned HTTP 200 through
Novita, but the definition remained invalid; zero packages, diagnostic exit 1.
Private receipt: `.local/free-model-results/1791285991414/benchmark.json`.
This is negative quality evidence, not successful multi-model acceptance.

## Repeatable layered benchmark

`scripts/benchmark-free-models.mjs` accepts `apodex`, `ling` or `layered`.
Layered uses Apodex for intent, Ling for generation and Apodex for repair, with
the unchanged Rust parser, typed-contract/capability validation, behavioral
tests and signer between generation and delivery. This is an experiment, not
evidence that another model improves quality or an independent semantic critic.

Run through token_guard with `NEEDWARE_OPENROUTER_API_KEY` supplied securely in
the environment. Default is one synthetic counter; `--all-apps` adds habits and
contacts. Fresh ZDR metadata and free quota must pass first. The entire run has
at most 12 calls, reduced to the remaining daily allowance; first upstream 429
stops subsequent trials. Unknown/nonzero cost or unexpected successful provider
stops the run. Plugins, tools and paid routing are stripped from requests.
Only the relay holds the upstream key; native children inherit no production
environment and use random loopback credentials/signing identities. Private
receipts retain synthetic requests/responses and the native binary SHA-256.
Failed generation exits nonzero. Policy regression checks run in `pnpm check`.

Before enablement, prove multiple representative apps and revisions against
independent acceptance cases, then browser behavior. Production integration
still needs truthful recipient disclosures, shared durable quota reservations,
bounded worker execution, cancellations/recovery, private ingress, and a
verified provider retention policy. Stop at quota exhaustion; never buy credit,
silently switch to paid models, weaken validation or substitute authored apps.
