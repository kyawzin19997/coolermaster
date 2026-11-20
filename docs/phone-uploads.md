# Upload from Phone

1. In MasterDeck, open **Plugins → Upload from Phone**.
2. Choose **Local Wi-Fi** with both devices on the same trusted private network. Scan the QR code with your phone’s camera and open the link. The phone uses its browser.
3. Match the six-character code on both screens, then select **Approve** on the desktop. Choose files or drop them onto the phone page.
4. When MasterDeck marks a file **Received and verified**, choose **Review plugin**, **Import**, or **Save a copy**. Plugin review happens before installation, and enabling the plugin is a separate action.

The QR code expires after five minutes. An approved session lasts up to one hour. Closing the desktop panel leaves transfers running. Use **End session** to disconnect the phone. Uploads resume from the saved offset in that session if the browser loses the connection. If the browser closes, reopen the upload page in the same session and choose the same file again. Cancelling removes the incomplete file. Completed files stay in MasterDeck’s local `phone-inbox` directory. A session accepts 32 files and 1 GiB in total, with a 300 MB limit per file. Identical files are deduplicated within a session.

Local Wi-Fi uses HTTP directly to the desktop’s private IPv4 address. Use a network you trust. Windows Firewall may ask whether to allow MasterDeck on private networks. Allow it only on the private network you intend to use. If the page times out, check that both devices are on the same network and that client isolation, a guest network, or a VPN is not blocking direct connections. Open a new session after changing networks.

## Internet mode with a configured HTTPS relay

Internet mode remains unavailable until MasterDeck verifies a configured HTTPS tunnel. The tunnel is optional and is operated by the person sharing the desktop. The standard Windows installer does not provision a relay account or publish a desktop port.

1. Create a named HTTPS tunnel on a domain you control, for example with Cloudflare Tunnel or an equivalent HTTPS reverse tunnel. Forward its dedicated public hostname to `http://127.0.0.1:46617` on the same computer as MasterDeck. Preserve the public Host header and require HTTPS at the edge. Do not point it at MasterDeck’s local API port. [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/)
2. Set the user environment variable `MASTERDECK_UPLOAD_HTTPS` to that exact HTTPS origin, such as `https://uploads.example.com`. Fully quit MasterDeck from the tray, then reopen it so the desktop process reads the setting.
3. Open **Upload from Phone → Internet**. MasterDeck probes the origin before displaying a QR code. If the tunnel is unavailable, repair it and choose **New session**. Local Wi-Fi remains available independently.

The Internet listener is bound to loopback and accepts the configured hostname. Each phone needs the temporary token in the QR link, a separate session ticket, and explicit desktop approval before it can upload. Traffic between the phone and the relay uses HTTPS. Use a tunnel provider you trust because it terminates TLS. MasterDeck streams the data to disk on the desktop and sends `Cache-Control: no-store`.
