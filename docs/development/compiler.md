# Compiler development and evidence

`pnpm dev` starts the loopback-only Axum compiler gateway and Next.js shell with an ephemeral internal host token. Set the provider, model and explicit input/output rates in a root ignored `.env`; use `.env.example` as the template. A local provider requires `NEEDWARE_ALLOW_LOOPBACK=1`. Hosted credentials remain in Rust; private host authorization remains in Node/Rust. No credential is represented by the generated browser contracts.

The UI identifies the configured recipient and credential owner and requires consent before sending a description. No provider configuration means generation is disabled; authored examples/imports still execute locally. Cancellation closes the request. Native CLI compilation is also available:

```sh
cargo run -p needware-cli -- compile prompt.txt result.need --acceptance cases.json
```

CLI configuration comes from its process environment. Output uses a fresh local signing identity and never overwrites an existing package implicitly. Review the signer fingerprint when importing.

The pipeline extracts typed intent, normalizes it, requests a schema-constrained definition, strictly parses it, validates references/data/capabilities, executes candidate and independently supplied acceptance tests in Rust, repairs at most twice, and independently verifies the signed result. Overall timeout is at most 180 seconds; each HTTP request at most 60. Prompts and definitions are transient and are not logged. Adapters never change recipients through automatic fallback.

Provider schemas are mechanically projected from Rust. Recursive expressions, actions, types, values and UI nodes become bounded indexed tables; maps become unique key/value arrays. Reconstruction rejects cycles, dangling references, duplicate keys and expansion limits. The provider projection is acyclic because [Claude's structured output constraints](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) exclude recursive schemas. [OpenAI Responses](https://developers.openai.com/api/docs/guides/structured-outputs), [Gemini Interactions](https://ai.google.dev/api/interactions-api) and local OpenAI-compatible adapters have separate HTTP contracts. Unsupported constraints remain enforced locally.

Usage records distinguish provider-reported token counts, configured-price estimates, and conservative reservations for requests with unknown usage. Rates must be explicitly configured, including zero for local inference. Estimates are not invoices or a guarantee against provider billing differences. Durable job metadata, account quotas, global spending circuit breakers, capability inference beyond current coverage, immutable refinement and a larger independent intent corpus remain implementation work. Model-written tests alone do not establish semantic correctness.

`pnpm build && pnpm test:compiler` runs an isolated, visibly labeled HTTP fixture through the actual Rust gateway and browser. The fixture is not a model and is never configured automatically for product use. Tests cover recipient consent, actual stage records, validation/signing, review before execution, cancellation, CSRF denial and WASM mutations. Native tests additionally cover all four HTTP contracts, bounded repair, independent failing acceptance, schema cycles/duplicates, budget denial and reasoning-token accounting. Real model output quality, credentialed requests and provider-specific schema acceptance are unverified until real integration runs occur.

This gateway binds only to loopback. Cloud exposure waits for account authorization, durable jobs/quotas and database integration. It is not a completed hosted control plane.
