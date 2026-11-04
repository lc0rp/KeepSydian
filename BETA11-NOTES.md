# KeepSydian 2.1.0-beta.11

Google master tokens stay on the client; the new backend protocol receives and validates short-lived access tokens. Desktop and Android use their reviewed local Google exchange transports. Backend keyring persistence is disabled; existing credential files are not deleted.

iOS has not yet been tested. Its Google transport and backend-origin compatibility are unverified and may prevent authentication or sync. This beta does not claim iOS compatibility.

Unknown or incompatible backends fail closed without sending master tokens as a fallback. Existing older client/backend routes are unchanged and retain their earlier behavior. No recovery-infrastructure or backup-behavior changes are included.

Validation includes synthetic client/server tests, independent and Claude Opus 5.5 High reviews, bounded desktop Google/Keep read evidence, and Android Google authentication evidence. These do not establish a full live sync on every platform.
