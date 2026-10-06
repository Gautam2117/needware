# Free inference research and layered diagnostics

Checked 2026-10-06. This is measured compatibility evidence and an enablement
gate, not a claim of unlimited inference or production generation readiness.
Owner-provided credentials remain in private ignored files. They are never
committed, passed in CLI arguments, or uploaded with the host probe.

## Current candidates

| Provider | Recurring allowance and constraints | Needware decision |
| --- | --- | --- |
| Cloudflare Workers AI | 10,000 neurons daily on Workers Free; exhaustion needs an explicit paid upgrade. Model-specific rates apply. Some newer models require paid billing. | Strong next benchmark candidate: fixed Cloudflare-hosted GPT-OSS or Qwen models, separate free account allowance, no AI Gateway paid/unified billing fallback. Credentials and account plan not yet verified. |
| Mistral | Official free mode is for evaluation/prototyping; RPS, TPM and monthly tokens are account-specific. API training can be opted out independently of Vibe. | Investigate actual account limits, production suitability, retention and opt-out before use. The reported 1 billion tokens/month is a community observation, not a verified allowance for this account. |
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
