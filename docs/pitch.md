0xChat

Pseudonymous, end-to-end encrypted chat where your identity is just an Ethereum address — no signup, no email, no phone number.

- Instant identity: opens with an auto-generated "burner wallet" keypair stored in your browser. Registration is automatic; there is no signup flow.
- Authenticated E2E encryption: every message is encrypted twice client-side (ECIES: ECDH + AES-256-GCM), bound to its metadata, and signed before upload. The current client sends ciphertext, not plaintext, and does not transmit private keys to the server.
- Talk to anyone by address: start a chat by entering an Ethereum address or scanning a QR code — no friend requests, no discovery service.
- Ephemeral by design: messages expire after a TTL you choose per message (5 seconds up to 24 hours), and the normal server deletes expired rows during cleanup. Expiry cannot erase recipient copies, logs, or backups.
- Real-time: live delivery via Server-Sent Events, plus optional payload-less Web Push for offline wakeups.
- Installable PWA: works like a native app on phone or desktop (add to home screen, offline app shell, touch-optimized UI).
- Self-custodial: you can export/import your keys and request deletion of your current server account data at any time.
- Clear limits: metadata remains visible. Security assumes HTTPS, authentic client code, and uncompromised endpoint keys; the protocol does not provide forward secrecy or post-compromise security.
