# `.need` — container format 1

MIME: `application/vnd.needware.package`. No compression or extraction paths.

| Field | Encoding |
|---|---|
| Magic | 8 bytes: `NEEDPKG` followed by zero |
| Format | u16 little-endian; must equal 1 |
| Manifest length | u32 little-endian; maximum 256 KiB |
| IR length | u32 little-endian; maximum 2 MiB |
| Asset count | u16 little-endian; maximum 256 |
| Manifest | JCS canonical UTF-8 JSON |
| IR | JCS canonical UTF-8 JSON |
| Assets | Ordered by digest; each u64 length followed by raw bytes |
| Signature count | u16 little-endian; 1–8 |
| Signatures | Each 32-byte Ed25519 public key followed by 64-byte signature |

The manifest contains `ir_digest` and ordered `assets` with digest, length and media type. Digests are lowercase BLAKE3 hex. Duplicate members, floating JSON numbers, noncanonical JSON, duplicate assets/signers, unsupported formats, trailing bytes and truncation fail verification.

Package digest hashes all bytes before the signature count. The signed message is `NEEDWARE-PACKAGE\0`, format u16 little-endian, and the 32-byte digest. Signature changes do not change content identity. Integrity does not establish signer trust or application safety.

Maximum package size is 32 MiB; each asset is at most 8 MiB. Only PNG/JPEG/WebP are accepted, with decoding limits (4096 per dimension, 64 MiB allocation). Executable/HTML/SVG assets are rejected. Invalid packages never produce a `VerifiedPackage`.
