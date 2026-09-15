# Componentize — CodeStitch → Astro

A Chrome extension that turns a CodeStitch stitch into a ready-to-use Astro
component in one click, replacing the copy-each-field-then-clean-it-up routine.

It adds a panel to any stitch page at
`https://codestitch.app/app/dashboard/stitches/<id>` and produces a component
for one of the two official CodeStitch kits.

## What it promises

The extension generates for **pristine, pinned versions** of the two official
kits. It cannot see your project, so it never guesses what you have changed —
instead every result carries one of two verdicts, shown in the panel and stamped
into the component's JSDoc:

| Verdict | Meaning |
| --- | --- |
| **Ready** | Builds as-is when dropped into the pinned kit: every file present, no unresolved links or imports, no dependency changes needed. |
| **Draft** | Something still needs a human: an unresolved link, untranslated locales, a dependency to install, styles it could not safely transform. The panel lists each reason. |

Pinned kits (regenerate with `npm run profiles`):

- [Advanced-Astro-i18n](https://github.com/CodeStitchOfficial/Advanced-Astro-i18n) — Astro 6, LESS, `en`/`fr`
- [Intermediate-Astro-Decap-CMS](https://github.com/CodeStitchOfficial/Intermediate-Astro-Decap-CMS) — Astro 7, LESS

A Ready verdict is a claim about those exact commits. If you have customised
your kit, treat every result as a draft.

The readiness invariant is strict: every `TODO` in generated output keeps it
Draft. Informational comments, including the CSPicture priority `Note:`, never
use that token.

The verdict describes **what you actually take away**. A component with
downloaded images or locale files is Ready as a ZIP but Draft when you copy or
download the `.astro` alone, because on its own it imports files you do not
have — the panel says so and points you at the ZIP.

## Install (development)

```bash
npm install && npm run build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**
and select the `dist/` directory. Open any stitch page and the panel appears
above the code viewer.

`npm run dev` runs the same build with hot reload.

## What it does to a stitch

- **Styles** — takes the flavour you pick (LESS is both kits' default) and the
  dark variant when you want dark mode, then removes only what the kit already
  provides globally: `:root` variables it defines, redundant redeclarations of
  `.cs-topper`/`.cs-title`/`.cs-text`/`.cs-button-solid`, and CodeStitch's demo
  Roboto font. Per-stitch overrides are kept — CodeStitch's docs expect them.
  Everything runs through postcss, so LESS idioms like `(16/16rem)` and
  `~"min(...)"` survive untouched. If the stylesheet cannot be parsed it is
  passed through unchanged and the result is a Draft.
- **Naming** — the file name is yours. It defaults to the CodeStitch convention
  (`Hero-1621`, `SideBySide-1982`, `NotFound-2501` — the stitch id keeps a second
  Hero from overwriting the first), and you can type anything you like in the
  panel. Hyphens are fine in a file name even though they are not valid in a JS
  identifier, so the component is imported under a derived binding
  (`Hero-1621.astro` → `import Hero1621`).
- **Images** — downloads every CodeStitch CDN image referenced in the markup
  *and* in the stylesheet, bundles them into the folder you choose, and rewrites
  standalone raster images to `<Image>`, ordinary `<picture>` elements
  to `<Picture>`, art-directed pictures to the kit's `<CSPicture>`, and SVGs
  to astro-icon `<Icon>`s. Astro owns responsive `srcset`/`sizes`
  generation for `<Image>` and `<Picture>`, so source-level responsive
  attributes are removed with one Draft warning; normal single-URL
  `<source srcset>` inputs are kept without warning. The **Images folder**
  field defaults to `src/assets/images/<stitch>` — matching how both kits
  group images by section — and accepts any folder under `src/assets`, since
  that is what the `@assets` alias resolves. File names get a short content
  hash so two different images that share a basename cannot overwrite each
  other. Switch to "Keep CodeStitch CDN" to leave the original markup alone.

  In asset mode, the panel offers **Prioritize first image**. It is a
  non-persistent, per-stitch choice and starts on when any top-level section id
  begins with `hero-`; the conversion core never infers hero status.
  When enabled, only the first eligible CDN raster image in DOM order gets bare
  Astro `priority`, and its conflicting lazy/loading attributes are omitted.
  An art-directed image remains on `<CSPicture>` because the pinned kit
  component hard-codes lazy loading; the output adds an informational plain
  `Note:` comment and never promotes a later image.

  Built-in image components also follow the pinned kit's Astro image config:
  profiles with an explicit layout respect it, while a profile that omits
  `image.layout` receives explicit `layout="constrained"`. Missing
  non-decorative `alt` attributes become `alt=""` plus a nearby
  accessibility diagnostic and one Draft warning. Explicitly empty or
  `aria-hidden` images are treated as decorative. Raster CSS backgrounds use
  Astro's format-neutral `getImage`; SVG and unsupported CSS formats retain
  imported raw `.src` URLs through the existing `define:vars` contract.
- **Links** — CodeStitch ships every link as `href=""`. Rather than ask you to
  fill in a dozen destinations that usually are not decided yet, each link gets a
  route read from its own label: "Privacy Policy" → `/privacy-policy`, "About" →
  `/about`, "Home" and the logo → `/`. They appear pre-filled in the panel, so
  editing one is a choice rather than a chore, and **Guess routes from link text**
  turns the whole thing off if you would rather mark them all TODO. Text that is
  plainly not a page name — opening hours, a street address, a phone number —
  is never slugified; those stay TODO. **Social links are recognised** and wired
  to the kit's own data — `href={BUSINESS.socials.facebook}`, with the import
  added — because "visit facebook profile" describes an action, not a page. A
  network the kit has no entry for falls back to that network's home page and
  says so, so you can add your profile to `src/data/client.ts`. Routes are
  checked against the pinned kit and anything it does not ship is reported in a
  single line, not one per link.

  The destination field takes all three forms: a route (`/about`), an absolute
  URL (`https://…`), or an expression in braces (`{BUSINESS.socials.twitter}`).
- **Text (i18n kit)** — replaces copy with `t("namespace:key")` lookups and
  writes a locale file for *every* locale the kit configures. Non-default
  locales start as English and are flagged as untranslated.
- **JavaScript** — wraps the stitch's script in `astro:page-load` so it re-runs
  after client-side navigation, and gives `document`/`window` listeners an
  `AbortController` that is aborted on each run so they cannot pile up. Timers
  and observers it cannot tie to that controller are reported as Draft reasons.
  A navigation stitch whose script duplicates the kit's sitewide `nav.js` is
  left out by default, so menus do not bind twice; the **Include JavaScript**
  toggle then starts unticked and says so. Tick it to keep the script anyway —
  the result is a Draft until one of the two scripts is removed.
- **Output** — copy the `.astro`, download it, or download a ZIP whose paths
  mirror the kit layout so it extracts straight over your project root. Choose
  the ZIP whenever there is more than one file; the badge tells you when the
  single-file options are not enough.

If an image cannot be downloaded, the original CDN markup is left in place and
the result is a Draft — the extension never emits an import for a file it did
not bundle.

## Tests

```bash
npm test              # unit + snapshot suites (happy-dom)
npm run test:e2e      # the real unpacked extension in Chrome (Playwright)
npm run test:acceptance   # generated components built inside both pinned kits
npm run test:all      # all of the above
```

`tests/__snapshots__/` holds real `.astro`, `.json` and readiness files — review
them like code; a diff there is a change to what users receive.

The acceptance run is the proof behind "Ready". For each fixture and kit it
clones the pinned kit, extracts the generated ZIP over it, writes a scratch page
that **imports and renders** the component through the kit's own `BaseLayout`,
and runs `astro build`. It then serves the built site and drives the component
in a real browser, checking that:

- the component's own root element renders at a usable size;
- the dark-mode rules it declares actually reach the built stylesheet, matched
  by selector against its own section ids;
- the page raises no console errors or failed requests from the site itself;
- its interactive behaviour works on first load, and still works **after a
  client-side navigation** — the failure `astro:page-load` wrapping prevents.

Light and dark screenshots are written to `.acceptance/screenshots/`.

Every one of those assertions is checked against a deliberate sabotage, because
several earlier versions of this harness passed while testing nothing at all:

| Guard | Why it exists |
| --- | --- |
| Scratch page is not `_`-prefixed | Astro never routes `src/pages/_*`, so the component was never built. |
| Rendered through the kit's `BaseLayout` | That is what mounts `<ClientRouter />`; without it `astro:page-load` never fires and every component script is dead. |
| Checks target the component's own root ids | The layout renders the kit's `<header>` first, so "the first section on the page" was the kit's navigation. |
| Dark rules matched by selector, not computed style | Both kits' `dark.less` restyles every heading site-wide, so "something changed in dark mode" passes even with the component's dark block deleted. |
| Navigation detours via an empty waypoint page | The kit's home page registers its own `astro:page-load` handlers, which survive later swaps and re-bind the component under test — making a dead component look alive. |
| A `window` marker proves the swap | Clicking a link to the current URL can be a no-op, leaving the original listeners in place. |

Pass `--no-browser` to run only the build half.

### Known issue in the pinned i18n kit

`Advanced-Astro-i18n` does not build at its pinned commit: its own
`Services.astro` passes SVGs to `<Picture>`, which Astro 6 rejects unless the
project sets `image.dangerouslyProcessSVG`. The acceptance harness applies that
setting to its scratch checkout so components can be verified against the kit;
the extension never emits it. If you hit this in your own project, either set
the flag or swap those `<Picture>` calls for astro-icon.

## Layout

```
src/
  content/     content-script.ts, selectors.ts, scrape.ts   — reading the stitch page
  background/  worker.ts                                     — CDN downloads only
  core/        convert.ts + html/, css/, js/, kits/          — the pure pipeline
  ui/          panel.ts, panel.css, prefs.ts                 — the injected panel
  output/      clipboard, download, zip
assets/        icon.svg, icon-16.svg                        — the mark, at two optical sizes
scripts/       capture-fixture, build-kit-profiles, kit-acceptance, build-icons
```

The panel's mark and the extension's icons are one drawing. `npm run icons`
rasterises `assets/` to `public/icons/*.png` with the Chromium Playwright
already installs, so there is no image toolchain to set up; 16px has its own
variant because the full mark smudges at that size.

`src/core/**` never touches `chrome.*` or page globals: it takes a parsed
document and an injected asset fetcher, which is why the whole pipeline is
testable without a browser.

`src/background/worker.ts` is the security boundary for downloads. The manifest
permission has to be broad (`https://*.digitaloceanspaces.com/*`), so the worker
holds an exact host allowlist, revalidates it on every redirect hop, requires an
`image/*` content type, and reads response bodies incrementally so a missing or
dishonest `Content-Length` cannot be used to exhaust memory.

Every CodeStitch selector lives in `src/content/selectors.ts`, so a redesign of
their site is a one-file fix. When the DOM stops matching, the panel says so
rather than failing silently — and it distinguishes the reasons, because they
send you to different places:

| What you see | What it means |
| --- | --- |
| No panel at all | Not a stitch's code page. The panel only runs on `/stitches/<id>`, never on `/stitches/<id>/rendered` or any other sub-page. |
| "CodeStitch did not show this stitch (403…)" | The site refused the stitch — sign in, or it needs a higher plan. Nothing is wrong with the extension. |
| "Code fields are empty" | The viewer is there but locked. |
| "CodeStitch changed its page layout" | An actual redesign; the selectors need updating. |

<sub>Built by [Oui Digital](https://oui.digital).</sub>
