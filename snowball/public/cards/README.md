# Card artwork

Drop card images in this folder, named by the card's **id** with a `.png` extension:

```
h_001.png      # hero  Bark Hexer
m_001.png      # monster
pl_001.png     # party leader
...
```

The id is the key used in the JSON definitions under `wiggles/src/cards/`
(e.g. the `"id"` field of each card).

## How it's used

`<CardArt cardId="h_001" />` renders `/cards/h_001.png`. Files in this `public/`
folder are served at the site root in dev and copied into the production build,
so no import or rebuild is needed — just add the file.

Any card without a matching image automatically shows a labelled placeholder, so
you can add art incrementally.

## Recommended format

- **Format:** PNG (the loader looks for `<id>.png`).
- **Aspect ratio:** 3:4 (portrait) — images are rendered with `object-fit: cover`
  at that ratio, so off-ratio art will be cropped.
- Keep files reasonably small (a few hundred KB) since they ship with the static site.
