# MasterDeck privacy

MasterDeck stores profiles, pictures, settings, and diagnostic logs on your computer. It has no MasterDeck account or telemetry service. You control which integrations and plugins run.

## When MasterDeck uses the network

| Feature | Connection |
| --- | --- |
| Update check | Reads the published release information from GitHub. |
| Local phone uploads | The phone sends files directly over your local Wi-Fi after you approve it. |
| Internet phone uploads | A configured HTTPS tunnel relays the transfer to your desktop. Files are saved in the local inbox. |
| Integrations, web actions, and media artwork | Connect to the app, service, or address required by the feature you set up. |
| Plugin catalog and installed plugins | The catalog retrieves plugin listings and packages. Enabled plugins run independently on your computer. |
| Optional assistant | Uses your configured provider. Review any consent prompt before sharing app usage information. |

Activity tracking for the deck stays local and can be turned off in the app. Music lighting and spectrum displays use system audio while active. macOS may request System Audio Recording permission for those features and per-app volume.

Review profile exports and diagnostic files before sharing them. They may contain action configuration, application names, or other details from your setup. [Security policy](SECURITY.md) · [Phone upload guide](docs/phone-uploads.md)
