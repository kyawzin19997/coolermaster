# Import and export profiles

A MasterDeck profile can be exported as a local file.

## The package: `.hubdeck`

A `.hubdeck` file is a zip archive:

```
profile.json          the profile, exactly as MasterDeck stores it
images/<name>         every picture the profile uses
```

- `profile.json` is the profile format of `app/src-tauri/src/engine/profile.rs` (`Profile`,
  `version` 1). Its `id` does not matter: an import always adds the profile under a new id and never
  overwrites one.
- `images/` holds every picture the profile refers to: key looks on all pages and gestures
  (`look.image`), the look while on (`lookOn.image`) and the full-panel picture
  (`panel: { kind: "picture", image }`). Names are the ones in `profile.json`: letters, digits, `.`,
  `-` and `_`, no folders. PNG, JPG, GIF (animated too), WebP and SVG.
- On import each picture is stored under a name made from its content, so two different pictures
  with the same name never clash; the profile's looks are updated to the new names. A picture that
  is missing or cannot be read is dropped from its look (the key keeps its icon and label).
- Limits: 15 MB per picture, 100 MB unpacked, 1000 files. Anything else in the zip is ignored.

Export: Profile panel > Export, file type "MasterDeck profile with its pictures". The plain JSON file
type ("Settings only") is still there for editing by hand; it has no pictures.

Import: Profile panel > Import takes `.hubdeck`, `.json` (MasterDeck) and `.mhz` (the official app's
export).

Sounds of the Play sound action and programs of Open app, file or website are paths on the
author's computer; they are not packed. After importing, check such keys.
