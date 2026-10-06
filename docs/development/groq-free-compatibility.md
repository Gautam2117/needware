# Groq Free compatibility evidence

Measured on 2026-10-06 with the owner's isolated Needware project on Groq Free. No paid upgrade or fallback was enabled. The private API key remains outside tracked files and hosted deployments.

The authenticated models endpoint returned active `qwen/qwen3.8-27b` and `openai/gpt-oss-120b`. Synthetic requests then ran through the existing compatible chat adapter and the real native compiler. A separate loopback diagnostic relay forwarded requests only to the fixed, certificate-verified Groq endpoint; it did not replace Rust validation, change production configuration, or use fixture responses.

## Observed blockers

- Qwen extracted a supported habit-tracker intent. Definition generation or repair failed with HTTP 429: the provider reported a 1,000 output-token-per-minute limit and an expected response of 7,636 tokens. These are observed account limits, not a promise of future allowance.
- A diagnostic cap of 1,000 tokens still exceeded the remaining allowance after intent extraction. Reducing it to 850 allowed a counter definition request, but Groq rejected the truncated document with HTTP 400 and missing required `types` and `values`.
- GPT-OSS completed intent extraction but incorrectly classified habit completion and undo as requiring executable code. Those operations are supported by Needware's declarative runtime; this is a model/prompt quality failure, not evidence that the product lacks them.
- None of these trials produced a verified signed package. Authentication, structured JSON support, and successful intent extraction do not establish generation readiness.

The gateway now distinguishes HTTP 429 as `provider_rate_limited`, without exposing the provider body or automatically retrying. Its regression test uses a real HTTP failure and verifies that compilation stops before definition generation or signing.

Local diagnostic receipts: `.logs/20261006T025356555581-64bzw8py.log`, `.logs/20261006T025456037877-sjvt_2wf.log`, and `.logs/20261006T025706665267-tfdzunk4.log`. Detailed synthetic request/response receipts remain in ignored `.local/groq-results/`; these are not production acceptance artifacts.

## Enablement gate

Keep hosted generation disabled until an explicit Groq provider profile, bounded request budgets and quota scheduling pass representative creation/revision behavioral tests, and the private hosted gateway is verified. Do not relabel this diagnostic adapter as production integration, raise limits through a paid upgrade, reduce validation, restrict all applications to a successful template, or claim unlimited inference.

Provider references: [structured outputs](https://console.groq.com/docs/structured-outputs), [data controls](https://console.groq.com/docs/your-data). Production privacy settings and public end-to-end generation remain unverified.
