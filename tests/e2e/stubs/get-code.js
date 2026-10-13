/*
 * Test stand-in for CodeStitch's site/js/get-code.js.
 *
 * Written for this project, not copied: it reproduces only the DOM contract the
 * extension reads (verified against the live page 2026-10-13), so tests stay
 * hermetic. Served at the real script URL by the e2e suite, and evaluated
 * directly by the unit tests.
 *
 * Behaviours that matter to the extension and are reproduced on purpose:
 *   - codes are bucketed the way CodeStitch does it, trusting `isDark` before
 *     the " Dark" suffix, so stitch 2501's "CSS Dark" (isDark: false) leaves
 *     the dark checkbox disabled under CSS, exactly as on the live site;
 *   - Single file and Shopify force CSS: the CSS button stays pressed and
 *     enabled, the others are disabled; Shopify hides the file name row;
 *   - link rows come from a regex over the raw markup, so anchors inside HTML
 *     comments are counted, and labels join tags with spaces;
 *   - every settings change re-renders segments and #link-rows with innerHTML;
 *     text fields update without re-rendering.
 *
 * window.__STUB_PREFS (optional) overrides the starting preferences.
 */
(function () {
	"use strict";

	var GC = window.GET_CODE;
	if (!GC || !GC.stitch) return;
	var CODES = GC.stitch.codes || [];

	var DEFAULTS = {
		format: "html", flavour: "css", darkStyles: true, includeJs: true,
		replaceLinks: true, guessRoutes: true, images: "cdn", imagesFolder: "/assets/images",
	};
	var prefs = Object.assign({}, DEFAULTS, window.__STUB_PREFS || {});
	var FLAVOURS = ["css", "less", "scss"];
	var CSS_ONLY = ["single", "shopify"];

	function $(s) { return document.querySelector(s); }
	function esc(s) {
		return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	function flavourOf(code) {
		if (code.type !== "css") return null;
		var name = String(code.typeName || "").toUpperCase().replace(/\s+DARK$/, "").trim();
		return { CSS: "css", LESS: "less", SCSS: "scss", SASS: "scss" }[name] || null;
	}
	function isDark(code) {
		if (code.isDark !== undefined && code.isDark !== null) return !!code.isDark;
		return /\s+dark$/i.test(String(code.typeName || ""));
	}
	var light = {}, dark = {};
	CODES.forEach(function (c) {
		var f = flavourOf(c);
		if (!f) return;
		var bucket = isDark(c) ? dark : light;
		if (!bucket[f]) bucket[f] = c;
	});
	var AVAILABLE = FLAVOURS.filter(function (f) { return light[f] || dark[f]; });
	var htmlCode = CODES.filter(function (c) { return c.type === "html"; })[0];
	var HTML = htmlCode ? htmlCode.content : "";
	var HAS_JS = CODES.some(function (c) { return c.type === "js" && String(c.content || "").trim(); });

	var ANCHOR = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a>/gi;
	var EMPTY_HREF = /(^|\s)href\s*=\s*(""|'')/i;
	function attr(attrs, name) {
		var m = attrs.match(new RegExp("(?:^|\\s)" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", "i"));
		return m ? (m[2] !== undefined ? m[2] : m[3]).trim() : "";
	}
	var LINKS = [];
	var m;
	ANCHOR.lastIndex = 0;
	while ((m = ANCHOR.exec(HTML)) !== null) {
		if (!EMPTY_HREF.test(m[1])) continue;
		var text = m[2].replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")
			.replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
		if (!text) text = attr(m[1], "aria-label");
		if (!text) { var img = m[2].match(/<img\b[^>]*>/i); if (img) text = attr(img[0], "alt"); }
		LINKS.push({ index: LINKS.length, text: text, classes: attr(m[1], "class") });
	}

	var GENERIC = ["learn more", "read more", "more", "click here", "here", "view more", "see more", "get started"];
	function guess(link) {
		if (/(^|\s)[\w-]*logo\b/i.test(link.classes)) return "/";
		var lower = link.text.toLowerCase();
		if (!lower) return "";
		if (/^(go )?(back )?(to )?(the )?(home|homepage|home page)$/.test(lower)) return "/";
		if (GENERIC.indexOf(lower) > -1) return "";
		if (/\b(facebook|instagram|twitter|linkedin|youtube|tiktok)\b/.test(lower)) return "";
		if (lower.split(" ").length > 5) return "";
		var slug = lower.replace(/['’]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
		return slug ? "/" + slug : "";
	}

	var edits = {};
	var firstId = (HTML.replace(/<!--[\s\S]*?-->/g, "").match(/<[a-z][^>]*?\sid\s*=\s*("([^"]+)"|'([^']+)')/i) || []);
	var idText = (firstId[2] || firstId[3] || "").replace(/^cs-/, "");
	var DEFAULT_NAME = idText ? idText.charAt(0).toUpperCase() + idText.slice(1) : "Stitch";

	function effectiveFlavour() {
		if (CSS_ONLY.indexOf(prefs.format) > -1) return "css";
		if (AVAILABLE.indexOf(prefs.flavour) > -1) return prefs.flavour;
		return AVAILABLE.indexOf("css") > -1 ? "css" : (AVAILABLE[0] || "css");
	}

	function seg(el, items) {
		el.innerHTML = items.map(function (it) {
			return '<button type="button" data-id="' + it.id + '" aria-pressed="' + (it.on ? "true" : "false") + '"' +
				(it.disabled ? " disabled" : "") + ">" + esc(it.label) + "</button>";
		}).join("");
	}
	function check(input, checked, disabled) {
		input.checked = checked;
		input.disabled = disabled;
	}

	function render() {
		var fl = effectiveFlavour();
		var cssOnly = CSS_ONLY.indexOf(prefs.format) > -1;
		seg($("#formats"), ["html", "single", "astro", "shopify"].map(function (id) {
			return { id: id, label: id, on: prefs.format === id };
		}));
		seg($("#flavours"), FLAVOURS.map(function (id) {
			return { id: id, label: id.toUpperCase(), on: fl === id,
				disabled: (cssOnly && id !== "css") || AVAILABLE.indexOf(id) === -1 };
		}));
		var hasDark = !!dark[fl];
		check($("#dark-styles"), !!prefs.darkStyles && hasDark, !hasDark);
		check($("#include-js"), !!prefs.includeJs && HAS_JS, !HAS_JS);

		var shopify = prefs.format === "shopify";
		$("#file-row").hidden = shopify;
		$("#section-id-row").hidden = !shopify;
		$("#section-name-row").hidden = !shopify;

		var local = prefs.images === "local";
		seg($("#image-modes"), [
			{ id: "cdn", label: "CodeStitch CDN", on: !local },
			{ id: "local", label: "Local folder", on: local },
		]);
		$("#folder-row").hidden = !local;

		$("#replace-links").checked = !!prefs.replaceLinks;
		check($("#guess-routes"), !!prefs.guessRoutes, !prefs.replaceLinks);
		$("#links-off").hidden = !!prefs.replaceLinks || !LINKS.length;
		$("#no-links").hidden = LINKS.length > 0;
		$("#link-rows").hidden = !prefs.replaceLinks;
		$("#link-rows").innerHTML = LINKS.map(function (l, i) {
			var edited = Object.prototype.hasOwnProperty.call(edits, l.index);
			var g = guess(l);
			var href = edited ? edits[l.index] : (prefs.guessRoutes ? g : "");
			var meta = !href ? "No destination yet, so this copies as an empty href"
				: "Link" + (!edited && prefs.guessRoutes && g ? " · guessed from the link text" : "");
			return '<div class="gc-link-row" data-i="' + i + '"><div class="gc-field">' +
				'<label for="link-' + i + '">' + esc(l.text || "Link " + (i + 1)) + "</label>" +
				'<input type="text" id="link-' + i + '" data-link="' + l.index + '" value="' + esc(href) + '">' +
				'</div><p class="gc-link-row__meta" id="link-meta-' + i + '">' + esc(meta) + "</p></div>";
		}).join("");
	}

	function onSeg(sel, key) {
		$(sel).addEventListener("click", function (e) {
			var b = e.target.closest("button[data-id]");
			if (b && !b.disabled) { prefs[key] = b.getAttribute("data-id"); render(); }
		});
	}
	onSeg("#formats", "format");
	onSeg("#flavours", "flavour");
	onSeg("#image-modes", "images");
	[["#dark-styles", "darkStyles"], ["#include-js", "includeJs"], ["#replace-links", "replaceLinks"], ["#guess-routes", "guessRoutes"]]
		.forEach(function (pair) {
			$(pair[0]).addEventListener("change", function (e) { prefs[pair[1]] = e.target.checked; render(); });
		});
	$("#images-folder").addEventListener("input", function (e) { prefs.imagesFolder = e.target.value; });
	$("#link-rows").addEventListener("input", function (e) {
		var input = e.target.closest("input[data-link]");
		if (input) edits[+input.getAttribute("data-link")] = input.value.trim();
	});
	$("#reset").addEventListener("click", function () {
		prefs = Object.assign({}, DEFAULTS);
		$("#images-folder").value = prefs.imagesFolder;
		render();
	});

	$("#file-name").placeholder = DEFAULT_NAME;
	$("#images-folder").value = prefs.imagesFolder;
	render();
}());
