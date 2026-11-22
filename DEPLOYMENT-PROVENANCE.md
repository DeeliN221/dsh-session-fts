# Deployed source provenance

This branch extends the unified-search client commit ddd941fc683d21e1c9c71de2a175b2469d02bcc5 with the exact five JavaScript Host modules deployed on 2026-11-22. It preserves the existing lexical/semantic and cross-device search implementation, not a new production deployment. Client bytes are unchanged.

The package manifest remains the maintained 0.3.6-zzl.1 source manifest; deployed manifest/README differ and are not treated as fresh source behavior. Existing tests must be evaluated against these recovered Host contracts before release. No indexes, session data, config, credentials, or embeddings are committed.
