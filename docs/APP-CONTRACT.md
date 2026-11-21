# Your app on the deck: the MasterDeck contract

How any app (including your own scripts) shows its state on the deck and
offers actions for keys, without knowing anything about MasterDeck. MasterDeck listens; the app only
publishes: the app publishes, MasterDeck subscribes, others can listen too.

Everything is optional. An app that only has `GET /masterdeck/status` already works.

## 1. The state: `GET /masterdeck/status`

An address on the app's own local port (`http://127.0.0.1:<port>/masterdeck/status`), answering JSON:

```json
{
  "app": "Agent Desk",
  "items": [
    { "id": "1", "label": "Agent 1", "state": "waiting", "text": "Needs your OK" },
    { "id": "2", "label": "Agent 2", "state": "working", "text": "Writing tests", "value": 0.4 }
  ]
}
```

- `id`: stable per item (a session, a job, a build). MasterDeck names it `<source>.<id>`
  (`launcher.1`); a key shows one item, the dial can count them (`launcher.*`).
- `state`, one of the shared scale below; anything else shows as text in a neutral color.
- `label` (optional): the item's name; `text` (optional): one short line about now;
  `value` (optional): a number (a progress 0..1, a count).

| state | means | on a key |
|---|---|---|
| `waiting` | it needs the user | orange, a hand; the deck's edge pulses orange |
| `working` | busy, nothing to do | blue, turning arrows |
| `done` | finished, worth a look | green, a check |
| `error` | failed | red, a cross |
| `idle` | nothing going on | grey dot |
| `offline` | not running / unreachable | dim, a dash |

MasterDeck reads it when a key or the dial shows the app (every 5 seconds at the fastest) unless the
app has an event stream.

## 2. Changes as they happen: `GET /masterdeck/events`

A Server-Sent Events stream (`Content-Type: text/event-stream`). Each event carries the items
that changed, in the same shape:

```
data: {"items":[{"id":"1","state":"working","text":"Back to work"}]}

```

MasterDeck subscribes while the app is connected, reconnects when the stream drops, and reads
`/masterdeck/status` once after each (re)connect. Any other program may subscribe too.

## 3. What keys can do: `GET /masterdeck/manifest`

MasterDeck reads the app manifest to list the actions it provides.

```json
{
  "app": "Agent Desk",
  "exe": "agent-desk.exe",
  "status": "http://127.0.0.1:4317/masterdeck/status",
  "events": "http://127.0.0.1:4317/masterdeck/events",
  "actions": [
    { "id": "focus", "label": "Focus agent", "icon": "bot", "method": "POST", "url": "http://127.0.0.1:4317/agents/{id}/focus" },
    { "id": "new", "label": "New agent", "icon": "plus", "method": "POST", "url": "http://127.0.0.1:4317/agents" },
    { "id": "open", "label": "Open", "icon": "app-window", "link": "agent-desk://open" }
  ]
}
```

- An action is an HTTP call (`method`, `url`, optional `body`) or a link (`link`: a deep link
  the app registered, opened like any address). `{id}` in a URL is the item's id when the key
  shows an item.
- `icon`: one of MasterDeck's icon names (`list_icons`), optional.
- A manifest may also live in a file (`hubdeck.json`) next to the app; then the user picks it.

## 4. No server at all: push

A script that cannot serve HTTP can tell MasterDeck directly (MasterDeck's local API, its port in
`%APPDATA%\dev.hubdeck.app\api-http-port`, its token in `api-token`):

```
curl -X POST http://127.0.0.1:<port>/api/state -H "Authorization: Bearer <token>" \
  -d '{"source":"backup","items":[{"id":"nightly","state":"done","text":"12 GB"}]}'
```

## 5. Connecting an app in MasterDeck

**By itself (recommended):** when the app starts, it announces its manifest, and MasterDeck connects
it without a click and says so in its window:

```
POST http://127.0.0.1:<port>/api/apps/announce   Authorization: Bearer <token>
{"url": "http://127.0.0.1:4317/masterdeck/manifest"}
-> {"ok": true, "id": "example-app", "new": true}
```

`<port>` is in `api-http-port` and `<token>` in `api-token` in MasterDeck's data folder
(`%APPDATA%\dev.hubdeck.app\` on Windows, `~/Library/Application Support/dev.hubdeck.app/` on
macOS). If the files are missing or the call fails, MasterDeck is not running: carry on quietly. An
app already connected is refreshed (a changed manifest is taken in); an app the user disconnected
is refused (`400`) until they add it again by hand. `scripts/example-app.py` shows it.

**By hand:** Settings > Connections > Your apps > Add: the address of its manifest (or of its
status) on this computer.
