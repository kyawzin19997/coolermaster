# MasterDeck security policy

Use the latest stable release when verifying a security issue. Include the MasterDeck version and operating system in your report. [Current release and checksums](https://github.com/kyawzin19997/coolermaster/releases/latest)

## Report privately

Use GitHub’s private vulnerability reporting form for vulnerabilities involving MasterDeck, its installers, the update feed, or phone uploads. Include the affected version, the conditions needed to encounter the issue, the expected impact, and any sanitized evidence that helps verify it. Keep credentials, pairing links, profile data, and personal file paths out of attachments. Share sensitive details through the private advisory discussion. [Report a vulnerability](https://github.com/kyawzin19997/coolermaster/security/advisories/new) · [How private reporting works](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately)

## Install and share safely

- Download installers from this repository’s Releases page and compare the SHA-256 checksum. Windows update packages carry a separate updater signature.
- Review a plugin’s origin before enabling it. Plugins run on your computer. Review imported profiles, especially actions that run commands or contact a service.
- Use local phone uploads on trusted Wi-Fi. Match the pairing code on both screens. Set up an HTTPS tunnel for uploads across networks and end the session when you finish.
- Store release keys, integration credentials, and private diagnostics outside Git.
