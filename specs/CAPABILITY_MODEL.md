# Capability model

All effects deny by default. A grant binds an application UUID, revision UUID and explicit capability scopes. Another application or revision cannot reuse that grant. Requested scopes must be valid and covered by both the manifest and consent.

Storage scopes identify collections and separate synchronized/local access and writes. HTTPS network scopes specify exact origins, methods and response limits. Files have direction, MIME allowlists and limits. Clipboard reads/writes, camera, microphone, location, local/push notifications, share, AI and collaboration are distinct capabilities.

Origin paths, embedded credentials, wildcards, localhost and literal IP origins are rejected. This is capability-manifest validation, not a complete DNS/SSRF relay defense. The hardened server relay is not implemented yet.

Broader scopes require new consent. Human-readable permission UI and server/broker enforcement must be wired before remote capabilities are available to consumer applications.
