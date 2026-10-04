# Client-owned keys and two recovery paths

Implementation follows the requested trusted-device OR user-held recovery-code
model. The encryption root is client-generated. The service stores ciphertext
wraps and public authorization metadata, without a universal recovery secret.
Document keys are random, independently rotatable and shared through verified
recipient-device keys. A collaborator receives document keys, never an account
root. Password reset remains separate from encrypted-data recovery.

Maintained HPKE handles recipient key encapsulation; existing maintained
XChaCha20-Poly1305, HKDF and Ed25519 libraries handle authenticated wraps and
attestations. Every envelope binds its identity, purpose, version and epochs.
API consumers must supply expected trust anchors instead of trusting an
envelope's claimed issuer. Signed authority-transition records verify the previous pin and the exact next
epoch. Complete browser/server integration, rotation transactions and signed
sync frames remain open.

See [the encryption hierarchy](../security/ENCRYPTION_HIERARCHY.md) for implemented
boundaries, metadata exposure and recovery/revocation limits. See the executable
vault tests for enrollment, document-only sharing, loss/recovery, tampering,
purpose isolation, resource limits and fresh-key rejection.
