import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import puppeteer from "puppeteer-core";
import { startServer } from "../src/server.ts";

const CHROME =
	process.env.CHROME_BIN ??
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = "/tmp/pi-rpc-web-mobile-ui";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
let UNSUPPORTED_IMAGE =
	process.env.PI_RPC_WEB_IMAGE_FIXTURE ?? `${OUT}/unsupported-upload.svg`;
if (!process.env.PI_RPC_WEB_IMAGE_FIXTURE) {
	const svg = `${OUT}/unsupported-upload.svg`;
	fs.writeFileSync(
		svg,
		'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#00d8ff"/></svg>',
	);
	if (process.platform === "darwin") {
		const heic = `${OUT}/unsupported-upload.heic`;
		try {
			execFileSync("/usr/bin/sips", ["-s", "format", "heic", svg, "--out", heic], {
				stdio: "ignore",
			});
			UNSUPPORTED_IMAGE = heic;
		} catch {
			UNSUPPORTED_IMAGE = svg;
		}
	}
}
const loginOnly = process.argv.includes("--login-only");

const LONG_PROSE =
	"https://example.invalid/" + "segment/".repeat(24) + "final-artifact.jsonl";
const NESTED_IDENTIFIER = "identifier_".repeat(16);
const INLINE_IDENTIFIER = "very_long_identifier_".repeat(12);
const WIDE_CODE_LINE = `const wide = "${"0123456789".repeat(24)}";`;
const WIDE_TOOL_PATH = "/very/long/tool/path/".repeat(24);
const WIDE_TABLE_HEADINGS = Array.from(
	{ length: 8 },
	() => "<th>wide heading</th>",
).join("");
const WIDE_TABLE_VALUES = Array.from(
	{ length: 8 },
	() => "<td>wide value</td>",
).join("");
const WIDE_CHAT_FIXTURE = `
<li class="msg assistant">
	<div class="msg-inner assistant-body">
		<div class="md">
			<h2>Mobile width audit</h2>
			<p>Normal prose remains readable across a narrow phone viewport.</p>
			<p class="long-prose">${LONG_PROSE}</p>
			<blockquote>Nested diagnostic text must stay inside the message boundary.</blockquote>
			<ul><li>first level<ul><li>nested item with ${NESTED_IDENTIFIER}</li></ul></li></ul>
			<p>Inline <code>${INLINE_IDENTIFIER}</code> must wrap.</p>
			<div class="code-block">
				<div class="code-head"><span class="code-lang">typescript</span><button type="button" class="copy-btn">Copy</button></div>
				<pre><code>${WIDE_CODE_LINE}</code></pre>
			</div>
			<div class="table-wrap"><table><thead><tr>${WIDE_TABLE_HEADINGS}</tr></thead><tbody><tr>${WIDE_TABLE_VALUES}</tr></tbody></table></div>
		</div>
	</div>
</li>
<li class="msg assistant">
	<div class="msg-inner assistant-body">
		<div class="tool-card open" data-state="ok"><div class="tool-body"><pre class="tool-output">${WIDE_TOOL_PATH}</pre></div></div>
	</div>
</li>`;
const MOBILE_SIDEBAR_FIXTURE = `
<div class="side-group"><span class="side-group-label">mobile-fixture</span><button class="icon-btn" aria-label="Project actions">×</button></div>
<div class="sess current">
  <button class="sess-main"><span class="sess-name">Mobile fixture session</span><span class="sess-meta">now · 12 lines</span></button>
  <span class="sess-actions"><button class="icon-btn" aria-label="Rename">✎</button><button class="icon-btn" aria-label="Delete">×</button></span>
</div>`;
const MOBILE_MODAL_FIXTURE = `
<div class="modal-backdrop in">
  <section class="modal" role="dialog" aria-modal="true">
    <h2 class="modal-title">Mobile confirmation</h2>
    <div class="modal-text">Confirm that actions remain reachable above the safe area.</div>
    <div class="modal-actions">
      <button class="btn">Cancel</button>
      <button class="btn">Review later</button>
      <button class="btn primary">Continue</button>
    </div>
  </section>
</div>`;

function mobileViewport(width, height) {
	return {
		width,
		height,
		deviceScaleFactor: 1,
		isMobile: true,
		hasTouch: true,
	};
}

function desktopViewport() {
	return {
		width: 1440,
		height: 900,
		deviceScaleFactor: 1,
		isMobile: false,
		hasTouch: false,
	};
}

async function assertLoginBounds(page, label) {
	const bounds = await page.evaluate(() => {
		const panel = document.querySelector("main")?.getBoundingClientRect();
		const input = document.querySelector("#pin")?.getBoundingClientRect();
		const button = document
			.querySelector('button[type="submit"]')
			?.getBoundingClientRect();
		return {
			docFits:
				document.documentElement.scrollWidth <=
				document.documentElement.clientWidth,
			bodyFits: document.body.scrollWidth <= document.body.clientWidth,
			panelLeft: panel?.left ?? -1,
			panelRight: panel?.right ?? -1,
			viewport: innerWidth,
			inputHeight: input?.height ?? 0,
			buttonHeight: button?.height ?? 0,
		};
	});
	assert.equal(bounds.docFits, true, `${label}: document overflowed`);
	assert.equal(bounds.bodyFits, true, `${label}: body overflowed`);
	assert.ok(
		bounds.panelLeft >= 0 && bounds.panelRight <= bounds.viewport,
		`${label}: panel overflowed viewport ${JSON.stringify(bounds)}`,
	);
	assert.ok(
		bounds.inputHeight >= 44,
		`${label}: input height too small ${bounds.inputHeight}`,
	);
	assert.ok(
		bounds.buttonHeight >= 44,
		`${label}: button height too small ${bounds.buttonHeight}`,
	);
}

async function gotoLogin(page, url) {
	await page.goto(`${url}/login`, { waitUntil: "networkidle2" });
	await page.waitForSelector("main.login-panel");
}

async function submitPin(page, pin, options = {}) {
	await page.focus("#pin");
	await page.$eval("#pin", (input) => {
		input.value = "";
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await page.keyboard.type(pin);
	const navigation = page.waitForNavigation({ waitUntil: "networkidle2" });
	await page.click('button[type="submit"]');
	const response = await navigation;
	if (options.expectedStatus != null) {
		assert.equal(response?.status(), options.expectedStatus);
	}
	return response;
}

async function loginToChat(page, url) {
	await page.setViewport(mobileViewport(390, 844));
	await gotoLogin(page, url);
	await submitPin(page, "482731");
	await page.waitForFunction(() => location.pathname === "/");
	await page.waitForSelector("#stream");
}

async function installWideChatFixture(page) {
	await page.evaluate((html) => {
		const stream = document.querySelector("#stream");
		if (!stream) throw new Error("#stream missing");
		document.querySelector("#chat-empty")?.setAttribute("hidden", "");
		stream.innerHTML = html;
		window.scrollTo(0, 0);
	}, WIDE_CHAT_FIXTURE);
}

async function installMobileShellFixture(page) {
	await page.evaluate(
		(sidebarHtml, fallbackMessage) => {
			const stream = document.querySelector("#stream");
			const sessions = document.querySelector("#sessions");
			const composerArea = document.querySelector("#composer-area");
			const composer = document.querySelector("#composer");
			if (!stream) throw new Error("#stream missing");
			if (!sessions) throw new Error("#sessions missing");
			if (!(composerArea instanceof HTMLElement))
				throw new Error("#composer-area missing");
			if (!(composer instanceof HTMLElement)) throw new Error("#composer missing");
			const preserved = stream.querySelector(".msg")?.outerHTML ?? fallbackMessage;
			document.querySelector("#chat-empty")?.setAttribute("hidden", "");
			stream.innerHTML = preserved;
			sessions.innerHTML = sidebarHtml;
			composerArea.hidden = false;
			composer.classList.remove("gated");
			document.body.classList.remove("sidebar-open");
			document.querySelector("#btn-menu")?.setAttribute("aria-expanded", "false");
			const contextWrap = document.querySelector("#ctx-wrap");
			const contextPct = document.querySelector("#ctx-pct");
			const contextFill = document.querySelector("#ctx-fill");
			if (contextWrap) contextWrap.className = "";
			if (contextPct) contextPct.textContent = "42%";
			if (contextFill instanceof HTMLElement) contextFill.style.width = "42%";
			window.scrollTo(0, 0);
		},
		MOBILE_SIDEBAR_FIXTURE,
		WIDE_CHAT_FIXTURE.split("</li>")[0] + "</li>",
	);
}

async function measureWideContent(page) {
	return page.evaluate(() => {
		const rect = (selector) => {
			const node = document.querySelector(selector);
			if (!node) throw new Error(`Missing ${selector}`);
			return node.getBoundingClientRect();
		};
		const code = document.querySelector(".code-block pre");
		const table = document.querySelector(".table-wrap");
		const stream = document.querySelector("#stream");
		if (!(code instanceof HTMLElement))
			throw new Error("Missing .code-block pre");
		if (!(table instanceof HTMLElement)) throw new Error("Missing .table-wrap");
		if (!(stream instanceof HTMLElement)) throw new Error("Missing #stream");
		const message = rect(".msg-inner");
		const longProse = rect(".long-prose");
		const toolCard = rect(".tool-card");
		const codeBlock = rect(".code-block");
		const tableWrap = rect(".table-wrap");
		const overflowing = [...stream.querySelectorAll("*")]
			.filter((node) => {
				if (!(node instanceof HTMLElement)) return false;
				const style = getComputedStyle(node);
				return (
					style.display !== "none" &&
					node.getClientRects().length > 0 &&
					node.scrollWidth > node.clientWidth + 1
				);
			})
			.map((node) => ({
				tag: node.tagName.toLowerCase(),
				className: node.className,
				scrollWidth: node.scrollWidth,
				clientWidth: node.clientWidth,
			}));
		return {
			viewport: innerWidth,
			doc: {
				scrollWidth: document.documentElement.scrollWidth,
				clientWidth: document.documentElement.clientWidth,
			},
			body: {
				scrollWidth: document.body.scrollWidth,
				clientWidth: document.body.clientWidth,
			},
			stream: {
				scrollWidth: stream.scrollWidth,
				clientWidth: stream.clientWidth,
			},
			message: {
				left: Math.round(message.left * 100) / 100,
				right: Math.round(message.right * 100) / 100,
				width: Math.round(message.width * 100) / 100,
			},
			prose: {
				right: Math.round(longProse.right * 100) / 100,
			},
			tool: {
				right: Math.round(toolCard.right * 100) / 100,
			},
			codeOuter: {
				right: Math.round(codeBlock.right * 100) / 100,
			},
			tableOuter: {
				right: Math.round(tableWrap.right * 100) / 100,
			},
			code: {
				scrollWidth: code.scrollWidth,
				clientWidth: code.clientWidth,
			},
			table: {
				scrollWidth: table.scrollWidth,
				clientWidth: table.clientWidth,
			},
			docFits:
				document.documentElement.scrollWidth <=
				document.documentElement.clientWidth,
			bodyFits: document.body.scrollWidth <= document.body.clientWidth,
			streamFits: stream.scrollWidth <= stream.clientWidth,
			proseFits: longProse.right <= message.right + 1,
			toolFits: toolCard.right <= message.right + 1,
			codeOuterFits: codeBlock.right <= message.right + 1,
			tableOuterFits: tableWrap.right <= message.right + 1,
			codeFits: code.scrollWidth <= code.clientWidth,
			tableFits: table.scrollWidth <= table.clientWidth,
			overflowing,
		};
	});
}

function assertWideContent(metrics, label) {
	for (const key of [
		"docFits",
		"bodyFits",
		"streamFits",
		"proseFits",
		"toolFits",
		"codeOuterFits",
		"tableOuterFits",
	]) {
		assert.equal(
			metrics[key],
			true,
			`${label}: ${key} failed ${JSON.stringify(metrics)}`,
		);
	}
	for (const key of ["codeFits", "tableFits"]) {
		assert.equal(
			metrics[key],
			true,
			`${label}: ${key} failed ${JSON.stringify(metrics)}`,
		);
	}
	assert.deepEqual(
		metrics.overflowing,
		[],
		`${label}: descendants overflow horizontally ${JSON.stringify(metrics.overflowing)}`,
	);
}

async function measureDesktopWideContent(page) {
	return page.evaluate(() => {
		const code = document.querySelector(".code-block pre");
		const table = document.querySelector(".table-wrap");
		if (!(code instanceof HTMLElement)) throw new Error("Missing desktop code");
		if (!(table instanceof HTMLElement)) throw new Error("Missing desktop table");
		return {
			codeScrolls: code.scrollWidth > code.clientWidth,
			tableScrolls: table.scrollWidth > table.clientWidth,
			codeScrollWidth: code.scrollWidth,
			codeClientWidth: code.clientWidth,
			tableScrollWidth: table.scrollWidth,
			tableClientWidth: table.clientWidth,
		};
	});
}

function assertDesktopWideContent(metrics) {
	assert.equal(
		metrics.codeScrolls,
		true,
		`desktop code no longer scrolls ${JSON.stringify(metrics)}`,
	);
	assert.equal(
		metrics.tableScrolls,
		true,
		`desktop table no longer scrolls ${JSON.stringify(metrics)}`,
	);
}

async function measureMobileShell(page) {
	return page.evaluate(() => {
		const fixtureFill = document.querySelector("#ctx-fill");
		const fixturePct = document.querySelector("#ctx-pct");
		if (fixtureFill instanceof HTMLElement) {
			fixtureFill.style.transition = "none";
			fixtureFill.style.width = "42%";
		}
		if (fixturePct) fixturePct.textContent = "42%";
		const box = (selector) => {
			const node = document.querySelector(selector);
			if (!(node instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
			return node.getBoundingClientRect();
		};
		const inside = (r) => r.left >= 0 && r.right <= innerWidth;
		const thinking = box("#btn-thinking");
		const model = box("#btn-model");
		const attach = box("#btn-attach");
		const send = box("#btn-send");
		const inputNode = document.querySelector("#input");
		const hintNode = document.querySelector("#input-hint");
		const composerNode = document.querySelector("#composer");
		if (!(inputNode instanceof HTMLTextAreaElement))
			throw new Error("Missing #input");
		if (!(hintNode instanceof HTMLElement))
			throw new Error("Missing #input-hint");
		if (!(composerNode instanceof HTMLElement))
			throw new Error("Missing #composer");
		inputNode.value = "";
		inputNode.dispatchEvent(new Event("input", { bubbles: true }));
		const hintVisibleWhenEmpty = !hintNode.hidden;
		const emptyInput = box("#input");
		const emptySend = box("#btn-send");
		inputNode.value = "unbroken_mobile_input_".repeat(30);
		inputNode.dispatchEvent(new Event("input", { bubbles: true }));
		const hintHiddenWithText = hintNode.hidden;
		const stats = box("#stats");
		const contextBar = box("#ctx-bar");
		const contextFill = box("#ctx-fill");
		const contextPct = box("#ctx-pct");
		const inputStyle = getComputedStyle(inputNode);
		const placeholderStyle = getComputedStyle(inputNode, "::placeholder");
		const hintStyle = getComputedStyle(hintNode);
		const visualSize = (selector) => {
			const node = document.querySelector(selector);
			if (!(node instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
			const style = getComputedStyle(node, "::before");
			return {
				width: Number.parseFloat(style.width),
				height: Number.parseFloat(style.height),
			};
		};
		return {
			topbarFits: inside(box("#topbar")),
			thinkingFits: inside(thinking),
			modelFits: inside(model),
			thinkingHeight: thinking.height,
			modelHeight: model.height,
			attachWidth: attach.width,
			attachHeight: attach.height,
			attachVisual: visualSize("#btn-attach"),
			sendWidth: send.width,
			sendHeight: send.height,
			sendVisual: visualSize("#btn-send"),
			inputControlCenterDelta: Math.abs(
				(emptyInput.top + emptyInput.bottom - emptySend.top - emptySend.bottom) / 2,
			),
			inputPaddingTop: Number.parseFloat(inputStyle.paddingTop),
			inputPaddingBottom: Number.parseFloat(inputStyle.paddingBottom),
			inputFits: inputNode.scrollWidth <= inputNode.clientWidth,
			inputOverflowX: inputStyle.overflowX,
			inputTouchAction: inputStyle.touchAction,
			hintVisibleWhenEmpty,
			hintHiddenWithText,
			hintPosition: hintStyle.position,
			hintOutsideTextarea: !inputNode.contains(hintNode),
			nativePlaceholderTransparent: placeholderStyle.color === "rgba(0, 0, 0, 0)",
			composerFits: inside(box("#composer")),
			composerContentFits: composerNode.scrollWidth <= composerNode.clientWidth,
			projectTitle: document.querySelector("#session-title")?.textContent,
			statsDisplay: getComputedStyle(document.querySelector("#stats")).display,
			statsFits: inside(stats),
			contextBarDisplay: getComputedStyle(document.querySelector("#ctx-bar"))
				.display,
			contextBarWidth: contextBar.width,
			contextFillWidth: contextFill.width,
			contextPctText: document.querySelector("#ctx-pct")?.textContent,
			contextPctFits: inside(contextPct),
		};
	});
}

function assertMobileShell(metrics) {
	assert.ok(
		metrics.thinkingHeight >= 44,
		`thinking height ${metrics.thinkingHeight}`,
	);
	assert.ok(metrics.modelHeight >= 44, `model height ${metrics.modelHeight}`);
	assert.ok(
		metrics.attachWidth >= 44 && metrics.attachHeight >= 44,
		`attach geometry ${JSON.stringify(metrics)}`,
	);
	assert.ok(
		metrics.sendWidth >= 44 && metrics.sendHeight >= 44,
		`send geometry ${JSON.stringify(metrics)}`,
	);
	for (const [name, visual] of [
		["attach", metrics.attachVisual],
		["send", metrics.sendVisual],
	]) {
		assert.ok(
			visual.width === 32 && visual.height === 32,
			`${name} visual surface ${JSON.stringify(metrics)}`,
		);
	}
	assert.ok(
		metrics.inputControlCenterDelta <= 1,
		`composer controls are not vertically centered ${JSON.stringify(metrics)}`,
	);
	assert.equal(
		metrics.inputPaddingBottom - metrics.inputPaddingTop,
		4,
		`mobile hint text is not optically centered ${JSON.stringify(metrics)}`,
	);
	assert.equal(metrics.inputFits, true, "mobile input scrolls horizontally");
	assert.equal(
		metrics.inputOverflowX,
		"hidden",
		"mobile input overflow is not locked",
	);
	assert.equal(
		metrics.inputTouchAction,
		"pan-y",
		"mobile input allows sideways panning",
	);
	assert.equal(metrics.hintVisibleWhenEmpty, true, "mobile hint is missing");
	assert.equal(
		metrics.hintHiddenWithText,
		true,
		"mobile hint overlaps entered text",
	);
	assert.equal(
		metrics.hintPosition,
		"absolute",
		"mobile hint remains scrollable",
	);
	assert.equal(
		metrics.hintOutsideTextarea,
		true,
		"mobile hint is inside textarea",
	);
	assert.equal(
		metrics.nativePlaceholderTransparent,
		true,
		"native mobile placeholder remains visible",
	);
	assert.equal(
		metrics.composerContentFits,
		true,
		"mobile composer scrolls horizontally",
	);
	assert.equal(
		metrics.projectTitle,
		"pi-rpc-web",
		"landing top bar must show the product name before project selection",
	);
	assert.equal(metrics.statsDisplay, "flex", "mobile context stats are hidden");
	assert.equal(
		metrics.contextBarDisplay,
		"block",
		"mobile context bar is hidden",
	);
	assert.ok(metrics.contextBarWidth >= 44, "mobile context bar is too narrow");
	assert.ok(
		metrics.contextFillWidth > 0 &&
			metrics.contextFillWidth < metrics.contextBarWidth,
		`mobile context progress is not visible ${JSON.stringify(metrics)}`,
	);
	assert.equal(
		metrics.contextPctText,
		"42%",
		"mobile context percentage missing",
	);
	assert.equal(
		metrics.topbarFits &&
			metrics.thinkingFits &&
			metrics.modelFits &&
			metrics.composerFits &&
			metrics.statsFits &&
			metrics.contextPctFits,
		true,
		`mobile shell overflow ${JSON.stringify(metrics)}`,
	);
}

async function openAndMeasureDrawer(page) {
	await page.click("#btn-menu");
	await page.waitForFunction(
		() =>
			document.body.classList.contains("sidebar-open") &&
			document.querySelector("#sidebar")?.getBoundingClientRect().left >= 0,
	);
	return page.evaluate(() => {
		const side = document.querySelector("#sidebar")?.getBoundingClientRect();
		const actions = [
			...document.querySelectorAll(".sess-actions, .side-group .icon-btn"),
		];
		if (!side) throw new Error("Missing #sidebar");
		return {
			width: side.width,
			viewport: innerWidth,
			inside: side.left >= 0 && side.right <= innerWidth,
			actionOpacity: actions.map((el) =>
				Number.parseFloat(getComputedStyle(el).opacity),
			),
		};
	});
}

function assertDrawer(metrics) {
	assert.ok(
		metrics.width >= metrics.viewport * 0.8 && metrics.width <= 340.5,
		`drawer width ${JSON.stringify(metrics)}`,
	);
	assert.equal(
		metrics.inside,
		true,
		`drawer overflow ${JSON.stringify(metrics)}`,
	);
	assert.ok(
		metrics.actionOpacity.length >= 2,
		`missing drawer actions ${JSON.stringify(metrics)}`,
	);
	assert.ok(
		metrics.actionOpacity.every((value) => value > 0.5),
		`drawer action opacity ${JSON.stringify(metrics)}`,
	);
}

async function closeDrawer(page) {
	await page.evaluate(() => {
		document.body.classList.remove("sidebar-open");
		document.querySelector("#btn-menu")?.setAttribute("aria-expanded", "false");
	});
	await page.waitForFunction(
		() => !document.body.classList.contains("sidebar-open"),
	);
}

async function openAndMeasurePopover(page) {
	await page.$eval("#btn-model", (el) => el.click());
	await page.waitForSelector(".popover");
	const metrics = await page.$eval(".popover", (el) => {
		const r = el.getBoundingClientRect();
		return {
			left: r.left,
			right: r.right,
			bottom: r.bottom,
			viewportWidth: innerWidth,
			viewportHeight: innerHeight,
			maxHeight: Number.parseFloat(getComputedStyle(el).maxHeight),
		};
	});
	await page.screenshot({
		path: `${OUT}/07-popover-mobile.png`,
	});
	await page.click("#session-title");
	await page.waitForFunction(() => !document.querySelector(".popover"));
	return metrics;
}

function assertPopover(metrics) {
	assert.ok(
		metrics.left >= 8 && metrics.right <= metrics.viewportWidth - 8,
		`popover horizontal bounds ${JSON.stringify(metrics)}`,
	);
	assert.ok(
		metrics.bottom <= metrics.viewportHeight,
		`popover bottom ${JSON.stringify(metrics)}`,
	);
}

async function injectAndMeasureModal(page) {
	await page.evaluate((html) => {
		const root = document.querySelector("#modal-root");
		if (!(root instanceof HTMLElement)) throw new Error("Missing #modal-root");
		root.innerHTML = html;
	}, MOBILE_MODAL_FIXTURE);
	await page.waitForSelector(".modal-backdrop.in .modal");
	const metrics = await page.$eval(".modal", (el) => {
		const r = el.getBoundingClientRect();
		const actionRects = [...document.querySelectorAll(".modal-actions .btn")].map(
			(btn) => {
				const rect = btn.getBoundingClientRect();
				return {
					left: rect.left,
					right: rect.right,
					top: rect.top,
					bottom: rect.bottom,
					height: rect.height,
				};
			},
		);
		return {
			left: r.left,
			right: r.right,
			bottom: r.bottom,
			viewportWidth: innerWidth,
			viewportHeight: innerHeight,
			maxHeight: Number.parseFloat(getComputedStyle(el).maxHeight),
			actionRects,
		};
	});
	await page.screenshot({
		path: `${OUT}/08-modal-mobile.png`,
	});
	await page.evaluate(() => {
		document.querySelector(".modal-backdrop")?.remove();
	});
	return metrics;
}

function assertModal(metrics) {
	assert.ok(
		metrics.left >= 0 && metrics.right <= metrics.viewportWidth,
		`modal horizontal bounds ${JSON.stringify(metrics)}`,
	);
	assert.ok(
		metrics.bottom <= metrics.viewportHeight,
		`modal bottom ${JSON.stringify(metrics)}`,
	);
	assert.ok(
		metrics.maxHeight <= metrics.viewportHeight,
		`modal max-height ${JSON.stringify(metrics)}`,
	);
	assert.equal(
		metrics.actionRects.length,
		3,
		`modal action count ${JSON.stringify(metrics)}`,
	);
	assert.ok(
		metrics.actionRects.every((rect) => rect.height >= 44),
		`modal action heights ${JSON.stringify(metrics)}`,
	);
	assert.ok(
		metrics.actionRects.every(
			(rect) =>
				rect.left >= metrics.left &&
				rect.right <= metrics.right &&
				rect.left >= 0 &&
				rect.right <= metrics.viewportWidth &&
				rect.bottom <= metrics.viewportHeight,
		),
		`modal action visibility ${JSON.stringify(metrics)}`,
	);
	assert.ok(
		new Set(metrics.actionRects.map((rect) => Math.round(rect.top))).size > 1,
		`modal actions did not wrap ${JSON.stringify(metrics)}`,
	);
}

async function measureDesktopShell(page) {
	return page.evaluate(() => {
		const rect = (selector) => {
			const node = document.querySelector(selector);
			if (!(node instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
			return node.getBoundingClientRect();
		};
		const topbar = document.querySelector("#topbar");
		const menu = document.querySelector("#btn-menu");
		const sidebar = document.querySelector("#sidebar");
		if (!(topbar instanceof HTMLElement)) throw new Error("Missing #topbar");
		if (!(menu instanceof HTMLElement)) throw new Error("Missing #btn-menu");
		if (!(sidebar instanceof HTMLElement)) throw new Error("Missing #sidebar");
		return {
			topbarDisplay: getComputedStyle(topbar).display,
			menuDisplay: getComputedStyle(menu).display,
			sidebarPosition: getComputedStyle(sidebar).position,
			sidebarWidth: rect("#sidebar").width,
			thinkingHeight: rect("#btn-thinking").height,
			modelHeight: rect("#btn-model").height,
			attachHeight: rect("#btn-attach").height,
			sendHeight: rect("#btn-send").height,
		};
	});
}

function assertDesktopShell(metrics) {
	assert.equal(
		metrics.topbarDisplay,
		"flex",
		`desktop topbar ${JSON.stringify(metrics)}`,
	);
	assert.equal(
		metrics.menuDisplay,
		"none",
		`desktop menu ${JSON.stringify(metrics)}`,
	);
	assert.equal(
		metrics.sidebarPosition,
		"static",
		`desktop sidebar ${JSON.stringify(metrics)}`,
	);
	assert.ok(
		metrics.attachHeight > 0 && metrics.sendHeight > 0,
		`desktop active composer is hidden ${JSON.stringify(metrics)}`,
	);
}

async function main() {
	const server = await startServer({
		port: 0,
		host: "127.0.0.1",
		lanAuth: { pin: "482731", sessionId: () => "ef".repeat(32) },
	});
	let browser;

	try {
		browser = await puppeteer.launch({
			executablePath: CHROME,
			headless: "new",
			args: ["--no-sandbox", "--disable-gpu"],
		});
		const page = await browser.newPage();
		const pageErrors = [];
		const consoleErrors = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() !== "error") return;
			const text = message.text();
			if (
				text ===
				"Failed to load resource: the server responded with a status of 401 (Unauthorized)"
			)
				return;
			consoleErrors.push(text);
		});

		await page.emulateMediaFeatures([
			{ name: "prefers-reduced-motion", value: "reduce" },
		]);

		await page.setViewport(mobileViewport(390, 844));
		await gotoLogin(page, server.url);
		await page.waitForSelector(".feedback.info");
		await assertLoginBounds(page, "390px initial login");
		await page.screenshot({
			path: `${OUT}/01-login-mobile.png`,
			fullPage: true,
		});

		await submitPin(page, "111111", { expectedStatus: 401 });
		await page.waitForSelector(".feedback.error[role='alert']");
		await assertLoginBounds(page, "390px invalid login");
		assert.match(
			await page.$eval(".feedback.error", (node) => node.textContent ?? ""),
			/Invalid PIN/i,
		);
		await page.screenshot({
			path: `${OUT}/02-login-invalid-mobile.png`,
			fullPage: true,
		});

		await page.setViewport(mobileViewport(320, 640));
		await gotoLogin(page, server.url);
		await assertLoginBounds(page, "320px initial login");

		await page.setViewport(desktopViewport());
		await gotoLogin(page, server.url);
		await page.screenshot({
			path: `${OUT}/03-login-desktop.png`,
			fullPage: true,
		});

		let wideMetrics = null;
		let shellMetrics = null;
		let drawerMetrics = null;
		let popoverMetrics = null;
		let modalMetrics = null;
		let desktopMetrics = null;
		let desktopWideMetrics = null;
		if (!loginOnly) {
			await loginToChat(page, server.url);
			assert.equal(
				await page.$eval("#composer-area", (node) => node.hidden),
				true,
				"landing page disabled composer remains visible",
			);
			await installWideChatFixture(page);
			await page.setViewport(mobileViewport(390, 1280));
			await page.waitForFunction(() => window.innerWidth === 390);
			wideMetrics = {};

			wideMetrics.mobile390 = await measureWideContent(page);
			assertWideContent(wideMetrics.mobile390, "390px wide chat");
			await page.screenshot({
				path: `${OUT}/04-chat-wide-mobile.png`,
				fullPage: true,
			});

			await page.setViewport(mobileViewport(320, 640));
			await page.waitForFunction(() => window.innerWidth === 320);
			wideMetrics.mobile320 = await measureWideContent(page);
			assertWideContent(wideMetrics.mobile320, "320px wide chat");

			await page.setViewport(mobileViewport(390, 844));
			await page.waitForFunction(() => window.innerWidth === 390);
			await installMobileShellFixture(page);
			const uploadInput = await page.$("#file-input");
			if (!uploadInput) throw new Error("#file-input missing");
			await uploadInput.uploadFile(UNSUPPORTED_IMAGE);
			await page.waitForSelector(
				'.attach-thumb img[src^="data:image/jpeg;base64,"]',
			);
			await page.click(".attach-remove");
			shellMetrics = await measureMobileShell(page);
			assertMobileShell(shellMetrics);
			await page.$eval("#input", (node) => {
				node.value = "";
				node.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await page.screenshot({
				path: `${OUT}/05-app-mobile.png`,
			});

			drawerMetrics = await openAndMeasureDrawer(page);
			assertDrawer(drawerMetrics);
			await page.screenshot({
				path: `${OUT}/06-sidebar-mobile.png`,
			});

			await closeDrawer(page);
			popoverMetrics = await openAndMeasurePopover(page);
			assertPopover(popoverMetrics);

			modalMetrics = await injectAndMeasureModal(page);
			assertModal(modalMetrics);

			await page.setViewport(desktopViewport());
			await page.waitForFunction(() => window.innerWidth === 1440);
			await page.$eval("#composer-area", (node) => {
				node.hidden = false;
			});
			desktopMetrics = await measureDesktopShell(page);
			assertDesktopShell(desktopMetrics);
			await installWideChatFixture(page);
			desktopWideMetrics = await measureDesktopWideContent(page);
			assertDesktopWideContent(desktopWideMetrics);
		}

		const errors = [
			...pageErrors.map((error) => `pageerror: ${error}`),
			...consoleErrors.map((error) => `console: ${error}`),
		];
		assert.equal(
			errors.length,
			0,
			`unexpected browser errors: ${errors.join(" | ")}`,
		);

		if (wideMetrics) {
			console.log(
				`mobile-ui-test: wide-content geometry ${JSON.stringify(wideMetrics)}`,
			);
			console.log(
				`mobile-ui-test: shell geometry ${JSON.stringify(shellMetrics)}`,
			);
			console.log(
				`mobile-ui-test: drawer geometry ${JSON.stringify(drawerMetrics)}`,
			);
			console.log(
				`mobile-ui-test: popover geometry ${JSON.stringify(popoverMetrics)}`,
			);
			console.log(
				`mobile-ui-test: modal geometry ${JSON.stringify(modalMetrics)}`,
			);
			console.log(
				`mobile-ui-test: desktop geometry ${JSON.stringify(desktopMetrics)}`,
			);
			console.log(
				`mobile-ui-test: desktop wide-content ${JSON.stringify(desktopWideMetrics)}`,
			);
		}
		console.log(`mobile-ui-test: screenshot directory ${OUT}`);
		console.log("mobile-ui-test: all assertions passed");
	} finally {
		await browser?.close();
		await server.close();
	}
}

await main();
