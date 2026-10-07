# Netlify free hosting verification

On 2026-10-07 the owner-authorized Magnet migration completed from Free Legacy
to credit-based Free. The authenticated billing page showed $0, 300/300 monthly
credits, no saved card, no overage charges, and a period starting October 7.
The change covers all nine team sites and cannot be reversed to Legacy.

Eight published site roots returned HTTP 200 after migration: needware-preview,
oxygen-drugs-laboratories, websiteforge-ca, alpha-gym-web, gyan-bharti-smart-classes,
n-h-property-solution, nav-durga-construction, and wheres-that-place. magnetchat's
configured root returned 404. Its unchanged June 10, 2023 published deploy contains
three files under flutter-twitch-server, not a homepage; this does not establish
a migration regression or full application health. No unrelated site was edited.

Needware deploy `6ac5ec075a45780008e66abf` published exact commit
`c3306542086e7d92b7431be3ba3a75fd1b2a3f1f`; all three exact-commit CI workflows
passed. This proves preview publication, not hosted generation/account acceptance.

[Netlify compute](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/)
costs 10 credits/GB-hour across functions and other compute. Production deploys,
traffic and the other eight sites share the same finite allowance. Frequent cron
polling remains unqualified; prefer on-demand bounded draining. The migration
does not measure actual native compiler startup, function memory/runtime,
database/mail access, retry behavior or workload credit use. Do not enable a
production worker until those gates pass with the exact Linux artifact.
