# Market capacity and launch boundaries

Saved Needware applications run locally, including offline, after installation. Cloud synchronization, account recovery, hosted AI creation and payments require their respective services. Local execution is not tied to a model token or a running developer session.

| Service | Current protection | Expansion boundary |
| --- | --- | --- |
| Render origin | Edge static caching, five-minute health keep-warm, local/offline application execution | Free services share 750 monthly instance hours, can restart or suspend, and do not horizontally scale. Pings prevent idle sleep only while the service remains available. |
| Hosted AI | Shared 8,000 neurons/day; 4,000/account/day; concurrency two; at most three calls and 2,048 output tokens/call; durable worst-case reservations | Free 3/day and 20/month, Pro 50/day and 200/month are admission ceilings subject to shared capacity. No unlimited generation or guaranteed throughput. |
| Database | Verified remote TLS, schema readiness checks, daily encrypted exact-snapshot recovery | Actual database size is measured separately from provider plan, shared monthly egress and connection allowance. Check the exact Needware project before expanding traffic. |
| Transactional mail | Durable outbox, bounded dispatch, retry and deduplication | Resend free allowance is finite and shared. Monitor delivery and provider usage before acquisition campaigns. |
| Recovery | Private operations runner, dedicated read-only role, separate encryption key, seven-day encrypted retention | Other repositories share GitHub's included Actions/storage allowance. Keep its account spending budget at zero; investigate a failed or missing daily run. |

The current model is qualified against independent native counter, habit, form, expense and todo behavior checks. Routing to another free model requires its own credentials, quota reservation and the same qualification; a pool of finite free tiers does not establish reliable unlimited service. Client GPU inference also needs compatible hardware and substantial model downloads, so it is not a universal replacement.

Monthly ₹499/30-day and annual ₹4,990/365-day passes use fixed server prices, manual renewal and the same seven-day refund policy. Provider redirects and checkout sessions never grant access. Exact successful captured payment evidence grants the fixed period; pending/successful refunds and unresolved disputes revoke access. Cashfree Payment Gateway and recurring Subscriptions are separate products. The merchant's stated Payment Gateway permission does not prove a completed live charge or refund.

Sources: [Render free services](https://render.com/docs/free), [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Supabase pricing](https://supabase.com/pricing), [Resend pricing](https://resend.com/pricing), [Groq organization limits](https://console.groq.com/docs/rate-limits), [OpenRouter limits](https://openrouter.ai/docs/api-reference/limits), [WebLLM](https://github.com/mlc-ai/web-llm).
