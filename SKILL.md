---
name: componentize
description: Turn a draft, raw-CodeStitch-export, or otherwise rough component into a proper one that matches this project's own conventions (and, when the draft is CodeStitch-sourced, CodeStitch's own CSS naming rules). Use when asked to "componentize", "clean up", "convert", "productionize", or "turn into a proper component" a file — especially one with a CodeStitch snippet-ID name (e.g. Navigation-1722.astro), hardcoded CDN image URLs, empty href="" placeholders, or a raw <style> block copy-pasted straight from codestitch.app. Works for Astro components primarily, but the method (learn conventions → find what's already global → replace demo content → verify by running the app) generalizes to React/Vue/Svelte components too.
metadata:
  version: 1.0.0
---

Usage: `/componentize <path-to-component>`. If no path is given, ask
which component to convert before doing anything else.

This is a **judgment-heavy conversion**, not a mechanical reformat. Every
project this runs in has different conventions — find them before writing
anything. Work through the steps below in order, and stop to ask
(`AskUserQuestion`) whenever a decision is genuinely the user's to make
— see "Ask, don't assume" below for which ones those are.

## 0. Ask, don't assume

Do **not** silently do any of the following — confirm with the user
first if the task seems to call for it:

- **Renaming or deleting the target file.** A CodeStitch snippet ID in
  the filename (e.g. `-1722`) may be load-bearing to the user (a
  reference back to the original Stitch, a personal convention) even
  though it looks like build cruft. Default to keeping the existing
  filename. Only rename if asked.
- **Wiring the converted component into the live site** (swapping it
  into a layout/page that currently renders something else). Converting
  a file and *deploying* it as the site's actual header/section/whatever
  are two different asks — do the second only if the user requested it.
- **Fabricating content.** If the original has a data point with no
  backing source (an invented "opening hours" string, a stock phone
  number), don't silently invent a replacement. Either wire it to real
  project data (see step 3) or leave it as clearly-placeholder copy,
  matching whatever placeholder convention the project already has
  (bracketed `[Company Name]`-style tokens, "lorem ipsum," obvious
  stand-in copy — check how existing components handle the same gap).

## 1. Learn the local conventions before writing anything

Find sibling components — same directory first, then similarly-purposed
components elsewhere in the project's component folder. Read at least
two of them. Extract:

- Import shape: what utility/icon/data-fetching helpers do siblings
  reach for, and from where (check the framework config —
  `tsconfig.json`/`jsconfig.json` path aliases, a components barrel
  file, etc. — for the project's actual conventions; don't assume this
  repo uses the same aliases as the last one).
- Markup patterns: how conditional classes are built
  (`class:list`/`clsx`/`cn`/template literals — whatever this codebase
  uses), how active/current-page state is expressed, how
  toggles/dropdowns get wired up (ids, `aria-*` attributes).
- Styling structure: how breakpoints are organized, how a dark-mode (or
  other theme) variant is expressed, indentation and preprocessor
  conventions (Less/Sass/CSS Modules/Tailwind/etc.).
- Whether the draft is meant to be data-driven (reads a config/JSON/CMS
  source and maps over it) or intentionally hardcoded-but-copy-paste
  friendly. CodeStitch nav components in particular often ship in both
  flavors *on purpose* — match whichever flavor the draft already is,
  unless asked to change it.

A subagent (an `Explore`-type agent, or a quick general-purpose one) is
a good way to do this survey without burning main-context on file reads
if there are many candidate siblings.

## 2. Check what's already global — don't redeclare it

**If the draft is CodeStitch-sourced** (raw markup/classes copy-pasted
from codestitch.app — telltale signs: `cs-`-prefixed classes, a
numeric snippet ID in comments or the filename, CDN image URLs from a
CodeStitch asset host), fetch and read
**https://codestitch.app/documentation#css-naming-conventions**
(WebFetch) if you haven't already this session. The two things it
actually asks to be globalized are:

- The `:root` color/sizing variables — should live in one shared
  stylesheet, not restated per component.
- Exactly four classes: `.cs-topper`, `.cs-title`, `.cs-text`,
  `.cs-button-solid`. If the draft redeclares the *base* styling for
  any of these, delete the redeclaration and confirm the project's
  global stylesheet already has it (grep for it — don't assume). A
  per-breakpoint **override** of a global class (e.g.
  `.cs-button-solid { display: none; }` inside a mobile media query) is
  fine and expected — that's not the same as redeclaring the base rule.

Per CodeStitch's own docs, **everything else — including full
navigation/hamburger/dropdown CSS — is intentionally self-contained per
component**, even when it's largely identical across sibling variants
("every navigation... easy to edit", "every navigation... will have a
duplicate Stitch"). Don't invent a shared partial for this; matching
the project's existing duplication pattern across variants *is* the
correct, consistent choice, not a smell to fix.

**If the draft isn't CodeStitch-sourced**, the same principle still
applies in spirit: check whatever this project's actual design-system
docs or existing global stylesheet say is meant to be shared (theme
tokens/CSS variables, a handful of universal typography/button classes,
existing utility classes like `.hide-on-mobile`) before assuming
something needs local styling — grep the global stylesheet first.

## 3. Replace demo-only content with real project data — or leave it honestly placeholder

- External CDN image URLs from the source template's own asset host →
  replace with the project's own local asset pipeline (an icon
  component reading from a local icon set, `next/image`/`astro:assets`,
  whatever this project already uses — check a sibling for the pattern.
  If an icon is missing from the local set, add a small, minimal
  matching-style SVG rather than leaving the external URL in place).
- Empty `href=""` / obviously-fake copy → wire to real data where this
  project already has it (a client/business-info config file, a nav
  data file, a CMS content collection, env vars). If sibling components
  already resolve a given field this way, do the same for consistency.
- No backing data exists → see step 0's "fabricating content" rule.

## 4. Scripts: reuse shared/sitewide behavior before writing new logic, and respect the framework's navigation model

If this is an **Astro** project specifically, read
**https://docs.astro.build/en/basics/astro-components/** and
**https://docs.astro.build/en/guides/view-transitions/** if you haven't
already this session, and:

- Check for a sitewide script (often loaded from the layout's `<head>`)
  for behavior the draft's inline `<script>` duplicates — mobile menu
  toggle, dropdown open/close, keyboard handling, etc. often already
  live there, wrapped in
  `document.addEventListener("astro:page-load", () => { ... })` so they
  re-run after every client-side navigation. **Don't duplicate that
  logic into the component** — delete the draft's copy and rely on the
  shared script.
- If the component needs genuinely new behavior no sibling has, give it
  its own small `<script>`, and wrap whatever touches
  `document`/`window` in the same `astro:page-load` pattern (or
  `astro:after-swap` if it needs to re-bind to a specific element that
  gets replaced on swap — check how an existing component like a dark
  mode toggle handles this).
- If a child component you're placing here positions itself with
  hardcoded coordinates/CSS that assume a different parent layout, a
  scoped `:global(#child-id) { ... }` override in this component's own
  `<style>` is the sanctioned way to adapt it without forking the
  shared child component.

For **other frameworks** (React/Vue/Svelte/etc.), the equivalent check
is: is there a shared layout-level effect/listener already handling
this interaction (a root layout's `useEffect`, a Pinia/Zustand store,
a global event bus)? Reuse it before adding component-local state that
duplicates it. And if the framework has a client-side-routing/transition
system (React Router, Vue Router, Next's App Router, etc.), make sure
any `document`/`window`-level listener your new code adds gets
re-attached (or doesn't leak) across route changes — the exact
mechanism differs per framework/router, but the failure mode ("works on
first load, breaks after a client-side nav") is the same one Astro's
View Transitions guide describes.

## 5. Verify — actually load it, don't just eyeball the diff

Look for a project-specific "run/drive the app" skill first (check
`.claude/skills/` for one — often named `run-<project-name>` or
similar; the `/run` built-in skill can also find or fall back to a
sensible pattern for the project type). Use it, or build/use whatever
this project already has (`chromium-cli`, a Playwright script, a dev
server + browser) to:

- Screenshot the component at a mobile viewport and a desktop viewport.
- Exercise every interactive state it has: menu open/close, dropdown
  open (note: some nav dropdowns open on hover on desktop and click on
  mobile — check which), theme toggle, any scroll-triggered behavior.
- If the framework does client-side navigation, trigger one (click a
  nav link) and repeat the interactive checks on the new page — this is
  what actually proves any "re-bind after navigation" wiring works, not
  just that it looks right on first load.
- Check the browser console after each phase — zero tolerance for new
  console/page errors.

If the component isn't reachable from any page yet (converted but not
wired in — see step 0), temporarily import it into a scratch page or
render it directly to verify, and say so; don't skip verification just
because it's not live yet.

## 6. Report back

Say what moved to global vs. what stayed local and why (cite the
CodeStitch doc section if relevant), what data got wired up vs. left
placeholder, whether you touched a shared/sitewide script or added a
component-local one, and what you actually verified (viewports,
interactions, post-navigation recheck). If you left something as a
deliberate placeholder because no data backs it, call that out
explicitly rather than letting it look like an oversight.
