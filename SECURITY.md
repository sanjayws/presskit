# Security

Do not post credentials, customer content or exploitable security details in public
issues. Use the repository's private vulnerability reporting feature if enabled;
otherwise contact the maintainer privately before disclosing details.

Production secrets belong in Cloudflare Worker secrets. Never set DEV_AUTH_EMAIL
on a deployed Worker. Password accounts are administrator-created in D1, use salted
PBKDF2-SHA256 hashes, and have per-account/IP attempt limits. Resetting or disabling
an account revokes its password sessions; Google permissions are separate.

Use a restricted email domain unless you deliberately want open Google signup.
Rotate exposed credentials immediately; removing a file from Git does not revoke
its secrets. Review provider data policies before processing sensitive sources.
