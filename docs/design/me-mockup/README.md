# /me owner view — approved mockup (Dami, Sep 25)

Static mockup with SAMPLE data. Open `me.html` in a browser (it loads `home.css`, a copy of the
home page's stylesheet, and `me.css`). Screenshots: `desktop-light.png`, `desktop-dark.png`,
`phone-light.png`.

Design: taste-skill `minimalist-ui` (warm monochrome, flat 1px-bordered bento, pastel colour only
for meaning), with four deliberate departures: system font (matches the home page), no entry
animation (a dashboard must be readable without motion), plain backgrounds, no icons yet.

Approved decisions: sections = agents + grants (Read / Write / Update own as aligned pill chips,
granted = filled, not granted = dashed), recent records + who wrote them ("You said" vs
"<agent> inferred"), how saves reach Monad (direct / batched / pending anchor), Revoke per agent
with a passkey confirm panel carrying the disclosure sentence. Data: Envio index first, direct chain
reads as fallback.

The build spec is not in the public repo.
