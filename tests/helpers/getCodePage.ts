/**
 * Builds a minimal page in the shape of CodeStitch's redesigned Get code
 * screen: the inspector skeleton exactly as the server sends it (controls
 * present but empty, before CodeStitch's own script renders them), the
 * `window.GET_CODE` script, and the core-styles textareas.
 *
 * Shared by unit tests and the e2e stubs, so both exercise the same markup.
 */

export interface StubCode {
	typeName: string;
	type: "html" | "css" | "js" | string;
	isDark?: boolean | null;
	content: string;
}

export interface StubPageOptions {
	id?: number;
	title?: string;
	section?: string | null;
	category?: string | null;
	codes: StubCode[];
	/** Core styles by flavour; omit a key to leave its textarea out. */
	core?: Partial<Record<"css" | "less" | "scss", string>>;
	/** Pre-rendered inspector content, replacing the empty server skeleton. */
	inspectorHtml?: string;
	/** Extra markup appended to <body>, e.g. a <script src> for the e2e stub. */
	bodyExtra?: string;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The server-rendered inspector, before CodeStitch's script fills it in. */
export const SERVER_INSPECTOR = `
<section class="gc-section">
	<div class="gc-section__head"><h3 id="sec-code">Code</h3><div class="gc-spacer"></div><span class="gc-section__summary" id="code-summary"></span></div>
	<div class="gc-stack">
		<div class="gc-seg gc-seg--fill" role="group" id="formats"></div>
		<div class="gc-seg gc-seg--fill" role="group" id="flavours"></div>
		<p class="gc-hint" id="flavour-note" hidden></p>
		<div class="gc-checks">
			<label class="gc-check" id="dark-row"><input type="checkbox" id="dark-styles"><span class="gc-check__text"><span>Include dark mode styles</span><span class="gc-hint" id="dark-note" hidden></span></span></label>
			<label class="gc-check" id="js-row"><input type="checkbox" id="include-js"><span class="gc-check__text"><span>Include JavaScript</span><span class="gc-hint" id="js-note" hidden></span></span></label>
		</div>
		<div class="gc-field" id="file-row"><label for="file-name">File name</label><input type="text" id="file-name" spellcheck="false" autocomplete="off"><p class="gc-hint">Saves as <code class="gc-mono" id="file-out"></code></p></div>
		<div class="gc-field" id="section-id-row" hidden><label for="section-id">Section ID</label><input type="text" id="section-id"><p class="gc-hint" id="section-id-hint">Saves as <code class="gc-mono" id="section-file-out"></code></p></div>
		<div class="gc-field" id="section-name-row" hidden><label for="section-name">Section name</label><input type="text" id="section-name"></div>
	</div>
</section>
<section class="gc-section">
	<div class="gc-section__head"><h3 id="sec-images">Images</h3><div class="gc-spacer"></div><span class="gc-section__summary" id="images-summary"></span></div>
	<div class="gc-seg gc-seg--fill" role="group" aria-label="Image paths" id="image-modes"></div>
	<div class="gc-field gc-field--spaced" id="folder-row" hidden><label for="images-folder">Images folder</label><input type="text" id="images-folder" spellcheck="false" autocomplete="off"></div>
	<p class="gc-hint" id="images-hint"></p>
</section>
<section class="gc-section">
	<div class="gc-section__head gc-section__head--center"><h3 id="sec-links">Links</h3><span class="gc-badge" id="link-count"></span><div class="gc-spacer"></div><span class="gc-link-status" id="link-status"></span></div>
	<div class="gc-link-toggles">
		<label class="gc-inline-check"><input type="checkbox" id="replace-links"> Replace links</label>
		<label class="gc-inline-check" id="guess-row"><input type="checkbox" id="guess-routes"> Guess routes from link text</label>
	</div>
	<p class="gc-callout" id="links-off" hidden>Replace links is off, so every href copies empty.</p>
	<p class="gc-hint" id="no-links" hidden>This stitch has no empty links.</p>
	<div id="link-rows"></div>
</section>
<div class="gc-reset"><button type="button" class="gc-text-btn" id="reset">Reset to CodeStitch defaults</button></div>`;

export function getCodePage(options: StubPageOptions): string {
	const id = options.id ?? 2501;
	const data = {
		stitch: {
			id,
			title: options.title ?? `Stitch - ${id}`,
			section: options.section ?? "Interior Pages",
			category: options.category === undefined ? "404" : options.category,
			figmaUrl: null,
			previewUrl: `https://app.codestitch.app/app/dashboard/stitches/${id}/rendered?embed=1`,
			previewImages: {},
			hasPreviewCss: false,
			codes: options.codes.map((c) => ({
				typeName: c.typeName,
				type: c.type,
				isDark: c.isDark ?? /\sdark$/i.test(c.typeName),
				name: null,
				content: c.content,
			})),
		},
		preferences: null,
		saveUrl: null,
		showCoreStyles: true,
		loggedIn: false,
	};
	// PHP's json_encode escapes "/", which is what keeps "</script>" out of the
	// payload; do the same.
	const json = JSON.stringify(data).replace(/\//g, "\\/");
	const core = Object.entries(options.core ?? {})
		.map(
			([flavour, text]) =>
				`<textarea id="gc-core-${flavour}" hidden aria-hidden="true">${escapeHtml(text ?? "")}</textarea>`,
		)
		.join("");

	return `<!DOCTYPE html><html><head><title>${escapeHtml(data.stitch.title)} · Get code</title></head><body>
<main class="gc-page"><div class="gc-app">
	<header class="gc-header"></header>
	<div class="gc-body">
		<div class="gc-main"></div>
		<aside class="gc-inspector" aria-labelledby="get-code-title">
			<div class="gc-inspector__head"><h2 id="get-code-title">Get code</h2></div>
			<div class="gc-inspector__scroll">${options.inspectorHtml ?? SERVER_INSPECTOR}</div>
			<div class="gc-code-wrap"><section class="gc-code"><div id="file-tabs"></div><div id="code-body"></div></section></div>
		</aside>
	</div>
	${core}
</div></main>
<script>window.GET_CODE = ${json};</script>
<script>window.GET_CODE.icons = {"html":"x"};</script>
${options.bodyExtra ?? ""}
</body></html>`;
}
