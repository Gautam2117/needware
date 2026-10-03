# Dedicated worker storage and opaque renderer

SQLite synchronous OPFS access handles require a dedicated worker; a SharedWorker cannot host the selected VFS in the tested browser environments. A dedicated worker holds a Web Lock for database ownership. Follower workers issue serialized, typed storage requests through BroadcastChannel. Generation checks reject stale state writes; runtime state rolls back on persistence failure. Closing the owner allows another worker to acquire the lock on its next operation.

Storage initialization is separately serialized. The selected backend is remembered in IndexedDB. A first-time OPFS failure selects an explicitly reported IndexedDB backend. Failure after OPFS selection requires recovery and does not silently open an empty fallback database.

The sandbox frame has an opaque origin and only `allow-scripts`. Its trusted renderer is supplied inline with a SHA-256 CSP allowlist; its CSP prohibits all network requests. Application IR contains no source code or HTML. The shell obtains the renderer from a platform asset cached by its service worker. The frame cannot fetch its own assets offline through the shell's service worker because it is an opaque-origin client.

The production cache includes all Next.js static chunks and runtime binaries. Development HMR is excluded from offline evidence. Browser tests stop a real test HTTP proxy before cold reopening; this also avoids Playwright WebKit's offline toggle rejecting navigation before service-worker handling. Exact installed device acceptance remains separate.
