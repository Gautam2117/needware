# Security reporting

Do not publish vulnerabilities, private application contents, or credentials in public issues. Use GitHub's private vulnerability reporting when enabled. Until a private contact is configured, withhold exploit details from public reports.

Needware is under implementation and is not ready to host sensitive production data. The status document identifies controls that actually exist. Package signatures establish integrity and signer identity, not safety. Browser compromise and malicious delivered client code are outside the protection of cloud end-to-end encryption.

Security-critical code changes require executable regression tests. Secrets, production keys, customer data and environment files must never enter Git. The built-in credential-pattern scan supplements, rather than replaces, dependency audits and maintained secret-scanning tools.
