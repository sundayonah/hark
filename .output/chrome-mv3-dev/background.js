var background = (function() {
	// node_modules/wxt/dist/utils/define-background.mjs
	function defineBackground(arg) {
		if (arg == null || typeof arg === "function") return { main: arg };
		return arg;
	}
	// lib/config.ts
	var GOOGLE_CLIENT_ID = "257230353396-tuia3qm3i4n4dvvntrp1r27jofcu7b11.apps.googleusercontent.com";
	// lib/auth.ts
	var SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
	function authUrl(prompt, loginHint) {
		const p = new URLSearchParams({
			client_id: GOOGLE_CLIENT_ID,
			response_type: "token",
			redirect_uri: chrome.identity.getRedirectURL(),
			scope: SCOPE,
			prompt
		});
		if (loginHint) p.set("login_hint", loginHint);
		return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
	}
	async function runFlow(url, interactive) {
		try {
			const redirect = await chrome.identity.launchWebAuthFlow({
				url,
				interactive
			});
			if (!redirect) return null;
			const params = new URLSearchParams(new URL(redirect).hash.slice(1));
			const token = params.get("access_token");
			if (!token) return null;
			return {
				token,
				expiresAt: Date.now() + Number(params.get("expires_in") ?? 3600) * 1e3
			};
		} catch {
			return null;
		}
	}
	async function getSession() {
		const { session } = await chrome.storage.local.get("session");
		return session ?? null;
	}
	var refreshing = null;
	async function refresh(email) {
		const result = await runFlow(authUrl("none", email), false);
		if (!result) {
			await chrome.storage.local.set({ authed: false });
			return null;
		}
		await chrome.storage.local.set({
			session: {
				...result,
				email
			},
			authed: true
		});
		return result.token;
	}
	/** A valid access token, renewed silently when it has expired. */
	async function getToken(forceRefresh = false) {
		const session = await getSession();
		if (!session) return null;
		if (!forceRefresh && session.expiresAt - Date.now() > 6e4) return session.token;
		refreshing ??= refresh(session.email).finally(() => refreshing = null);
		return refreshing;
	}
	// lib/gmail.ts
	var API = "https://gmail.googleapis.com/gmail/v1/users/me";
	async function api(path, retry = true) {
		const token = await getToken();
		if (!token) throw new Error("Not connected");
		const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
		if (res.status === 401 && retry) {
			await getToken(true);
			return api(path, false);
		}
		if (!res.ok) throw new Error(`Gmail API ${res.status}`);
		return res.json();
	}
	/** Unread message IDs from any of the senders, newest first. */
	async function listUnread(senders) {
		const from = senders.map((s) => `from:${s}`).join(" OR ");
		return ((await api(`/messages?q=${encodeURIComponent(`(${from}) is:unread newer_than:2d`)}&maxResults=10`)).messages ?? []).map((m) => m.id);
	}
	async function getEmail(id) {
		const msg = await api(`/messages/${id}?format=full`);
		const headers = msg.payload?.headers ?? [];
		const h = (n) => headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
		const from = h("from");
		return {
			id,
			fromName: from.match(/^"?([^"<]+?)"?\s*</)?.[1]?.trim() || from.replace(/<.*>/, "").trim() || "unknown sender",
			subject: h("subject") || "no subject",
			body: extractBody(msg.payload)
		};
	}
	function decode(data) {
		const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
		return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
	}
	function findPart(part, mime) {
		if (!part) return null;
		if (part.mimeType === mime && part.body?.data) return decode(part.body.data);
		for (const p of part.parts ?? []) {
			const found = findPart(p, mime);
			if (found) return found;
		}
		return null;
	}
	function extractBody(payload) {
		const plain = findPart(payload, "text/plain");
		if (plain) return clean(plain);
		const html = findPart(payload, "text/html");
		return html ? clean(stripHtml(html)) : "";
	}
	function stripHtml(html) {
		return html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, "\"");
	}
	/** Make an email pleasant to listen to: drop links, quoted replies and footers. */
	function clean(text) {
		return text.split(/\n(?:On .+ wrote:|-{2,}\s*Original Message|Unsubscribe|You received this email)/i)[0].replace(/^>.*$/gm, "").replace(/https?:\/\/\S+/g, "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, ". ").replace(/\s*\n\s*/g, " ").trim();
	}
	// lib/settings.ts
	var DEFAULTS = {
		enabled: true,
		senders: [],
		rate: 1,
		mode: "short"
	};
	async function getSettings() {
		const { settings } = await chrome.storage.local.get("settings");
		return {
			...DEFAULTS,
			...settings ?? {}
		};
	}
	/** IDs of messages already handled. `null` means first run (no baseline yet). */
	async function getSeen() {
		const { seen } = await chrome.storage.local.get("seen");
		return Array.isArray(seen) ? seen : null;
	}
	async function setSeen(ids) {
		await chrome.storage.local.set({ seen: ids.slice(-200) });
	}
	// lib/speech.ts
	function speak(text, rate) {
		chrome.tts.speak(text.slice(0, 5e3), {
			rate,
			enqueue: true,
			onEvent: (e) => {
				if (e.type === "start") chrome.storage.local.set({ speaking: true });
				if ([
					"end",
					"interrupted",
					"cancelled",
					"error"
				].includes(e.type)) chrome.storage.local.set({ speaking: false });
			}
		});
	}
	// entrypoints/background.ts
	var ALARM = "hark-poll";
	var SHORT_LIMIT = 500;
	var FULL_LIMIT = 4e3;
	var polling = false;
	async function poll() {
		if (polling) return;
		polling = true;
		try {
			const s = await getSettings();
			if (!s.enabled || s.senders.length === 0) return;
			if (!await getToken()) return;
			const ids = await listUnread(s.senders);
			const seen = await getSeen();
			if (seen === null) {
				await setSeen(ids);
				return;
			}
			const fresh = ids.filter((id) => !seen.includes(id)).reverse();
			for (const id of fresh) {
				const mail = await getEmail(id);
				const limit = s.mode === "full" ? FULL_LIMIT : SHORT_LIMIT;
				const body = mail.body.length > limit ? mail.body.slice(0, limit) + "…" : mail.body;
				speak(`New email from ${mail.fromName}. Subject: ${mail.subject}. ${body}`, s.rate);
				seen.push(id);
				await setSeen(seen);
			}
		} catch (err) {
			console.error("[Hark] poll failed", err);
		} finally {
			await chrome.storage.local.set({ lastCheck: Date.now() });
			polling = false;
		}
	}
	var background_default = defineBackground(() => {
		chrome.alarms.create(ALARM, {
			delayInMinutes: .1,
			periodInMinutes: 1
		});
		chrome.alarms.onAlarm.addListener((a) => a.name === ALARM && poll());
		chrome.runtime.onStartup.addListener(() => poll());
		chrome.runtime.onMessage.addListener(async (msg) => {
			if (msg?.type === "check") poll();
			if (msg?.type === "test") speak("New email. Subject: Your next project is ready. This is how Hark will sound.", (await getSettings()).rate);
		});
	});
	// node_modules/wxt/dist/browser.mjs
	/**
	* Contains the `browser` export which you should use to access the extension
	* APIs in your project:
	*
	* ```ts
	* import { browser } from 'wxt/browser';
	*
	* browser.runtime.onInstalled.addListener(() => {
	*   // ...
	* });
	* ```
	*
	* @module wxt/browser
	*/
	var browser = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
	// node_modules/@webext-core/match-patterns/lib/index.mjs
	/**
	* Class for parsing and performing operations on match patterns.
	*
	* @example
	*   const pattern = new MatchPattern('*://google.com/*');
	*
	*   pattern.includes('https://google.com'); // true
	*   pattern.includes('http://youtube.com/watch?v=123'); // false
	*/
	var MatchPattern = class MatchPattern {
		static {
			this.PROTOCOLS = [
				"http",
				"https",
				"file",
				"ftp",
				"urn",
				"ws",
				"wss"
			];
		}
		/**
		* Parse a match pattern string. If it is invalid, the constructor will throw an
		* `InvalidMatchPattern` error.
		*
		* @param matchPattern The match pattern to parse.
		*/
		constructor(matchPattern) {
			if (matchPattern === "<all_urls>") {
				this.isAllUrls = true;
				this.protocolMatches = [...MatchPattern.PROTOCOLS];
				this.hostnameMatch = "*";
				this.pathnameMatch = "*";
			} else {
				const groups = /(.*):\/\/(.*?)(\/.*)/.exec(matchPattern);
				if (groups == null) throw new InvalidMatchPattern(matchPattern, "Incorrect format");
				const [_, protocol, hostname, pathname] = groups;
				validateProtocol(matchPattern, protocol);
				validateHostname(matchPattern, hostname);
				this.protocolMatches = protocol === "*" ? ["http", "https"] : [protocol];
				this.hostnameMatch = hostname;
				this.pathnameMatch = pathname;
			}
		}
		/** Check if a URL is included in a pattern. */
		includes(url) {
			const u = typeof url === "string" ? new URL(url) : url instanceof Location ? new URL(url.href) : url;
			if (this.isAllUrls) return !this.isUnknownProtocol(u);
			return !!this.protocolMatches.find((protocol) => {
				if (protocol === "http") return this.isHttpMatch(u);
				if (protocol === "https") return this.isHttpsMatch(u);
				if (protocol === "file") return this.isFileMatch(u);
				if (protocol === "ftp") return this.isFtpMatch(u);
				if (protocol === "urn") return this.isUrnMatch(u);
			});
		}
		isHttpMatch(url) {
			return url.protocol === "http:" && this.isHostPathMatch(url);
		}
		isHttpsMatch(url) {
			return url.protocol === "https:" && this.isHostPathMatch(url);
		}
		isHostPathMatch(url) {
			if (!this.hostnameMatch || !this.pathnameMatch) return false;
			const hostnameMatchRegexs = [this.convertPatternToRegex(this.hostnameMatch), this.convertPatternToRegex(this.hostnameMatch.replace(/^\*\./, ""))];
			const pathnameMatchRegex = this.convertPatternToRegex(this.pathnameMatch);
			return !!hostnameMatchRegexs.find((regex) => regex.test(url.hostname)) && pathnameMatchRegex.test(url.pathname);
		}
		isUnknownProtocol(url) {
			return !this.protocolMatches.includes(url.protocol.slice(0, -1));
		}
		isPathMatch(url) {
			if (!this.pathnameMatch) return false;
			return this.convertPatternToRegex(this.pathnameMatch).test(url.pathname);
		}
		isFileMatch(url) {
			return url.protocol === "file:" && this.isPathMatch(url);
		}
		isFtpMatch(_url) {
			throw Error("Not implemented: ftp:// pattern matching. Open a PR to add support");
		}
		isUrnMatch(_url) {
			throw Error("Not implemented: urn:// pattern matching. Open a PR to add support");
		}
		convertPatternToRegex(pattern) {
			const starsReplaced = this.escapeForRegex(pattern).replace(/\\\*/g, ".*");
			return RegExp(`^${starsReplaced}$`);
		}
		escapeForRegex(string) {
			return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	};
	var InvalidMatchPattern = class extends Error {
		constructor(matchPattern, reason) {
			super(`Invalid match pattern "${matchPattern}": ${reason}`);
		}
	};
	function validateProtocol(matchPattern, protocol) {
		if (!MatchPattern.PROTOCOLS.includes(protocol) && protocol !== "*") throw new InvalidMatchPattern(matchPattern, `${protocol} not a valid protocol (${MatchPattern.PROTOCOLS.join(", ")})`);
	}
	function validateHostname(matchPattern, hostname) {
		if (hostname.includes(":")) throw new InvalidMatchPattern(matchPattern, `Hostname cannot include a port`);
		if (hostname.includes("*") && hostname.length > 1 && !hostname.startsWith("*.")) throw new InvalidMatchPattern(matchPattern, `If using a wildcard (*), it must go at the start of the hostname`);
	}
	// \0virtual:wxt-background-entrypoint?/Users/onah/Desktop/code/personalprojects/hark/entrypoints/background.ts
	function print(method, ...args) {
		if (typeof args[0] === "string") method(`[wxt] ${args.shift()}`, ...args);
		else method("[wxt]", ...args);
	}
	/** Wrapper around `console` with a "[wxt]" prefix */
	var logger = {
		debug: (...args) => print(console.debug, ...args),
		log: (...args) => print(console.log, ...args),
		warn: (...args) => print(console.warn, ...args),
		error: (...args) => print(console.error, ...args)
	};
	var ws;
	/** Connect to the websocket and listen for messages. */
	function getDevServerWebSocket() {
		if (ws == null) {
			const serverUrl = "ws://localhost:3000";
			logger.debug("Connecting to dev server @", serverUrl);
			ws = new WebSocket(serverUrl, "vite-hmr");
			ws.addWxtEventListener = ws.addEventListener.bind(ws);
			ws.sendCustom = (event, payload) => ws?.send(JSON.stringify({
				type: "custom",
				event,
				payload
			}));
			ws.addEventListener("open", () => {
				logger.debug("Connected to dev server");
			});
			ws.addEventListener("close", () => {
				logger.debug("Disconnected from dev server");
			});
			ws.addEventListener("error", (event) => {
				logger.error("Failed to connect to dev server", event);
			});
			ws.addEventListener("message", (e) => {
				try {
					const message = JSON.parse(e.data);
					if (message.type === "custom") ws?.dispatchEvent(new CustomEvent(message.event, { detail: message.data }));
				} catch (err) {
					logger.error("Failed to handle message", err);
				}
			});
		}
		return ws;
	}
	/** https://developer.chrome.com/blog/longer-esw-lifetimes/ */
	function keepServiceWorkerAlive() {
		setInterval(async () => {
			await browser.runtime.getPlatformInfo();
		}, 5e3);
	}
	function reloadContentScript(payload) {
		if (browser.runtime.getManifest().manifest_version == 2) reloadContentScriptMv2(payload);
		else reloadContentScriptMv3(payload);
	}
	async function reloadContentScriptMv3({ registration, contentScript }) {
		if (registration === "runtime") await reloadRuntimeContentScriptMv3(contentScript);
		else await reloadManifestContentScriptMv3(contentScript);
	}
	async function reloadManifestContentScriptMv3(contentScript) {
		const id = `wxt:${contentScript.js[0]}`;
		logger.log("Reloading content script:", contentScript);
		const registered = await browser.scripting.getRegisteredContentScripts();
		logger.debug("Existing scripts:", registered);
		const existing = registered.find((cs) => cs.id === id);
		if (existing) {
			logger.debug("Updating content script", existing);
			await browser.scripting.updateContentScripts([{
				...contentScript,
				id,
				css: contentScript.css ?? []
			}]);
		} else {
			logger.debug("Registering new content script...");
			await browser.scripting.registerContentScripts([{
				...contentScript,
				id,
				css: contentScript.css ?? []
			}]);
		}
		await reloadTabsForContentScript(contentScript);
	}
	async function reloadRuntimeContentScriptMv3(contentScript) {
		logger.log("Reloading content script:", contentScript);
		const registered = await browser.scripting.getRegisteredContentScripts();
		logger.debug("Existing scripts:", registered);
		const matches = registered.filter((cs) => {
			const hasJs = contentScript.js?.find((js) => cs.js?.includes(js));
			const hasCss = contentScript.css?.find((css) => cs.css?.includes(css));
			return hasJs || hasCss;
		});
		if (matches.length === 0) {
			logger.log("Content script is not registered yet, nothing to reload", contentScript);
			return;
		}
		await browser.scripting.updateContentScripts(matches);
		await reloadTabsForContentScript(contentScript);
	}
	async function reloadTabsForContentScript(contentScript) {
		const allTabs = await browser.tabs.query({});
		const matchPatterns = contentScript.matches.map((match) => new MatchPattern(match));
		const matchingTabs = allTabs.filter((tab) => {
			const url = tab.url;
			if (!url) return false;
			return !!matchPatterns.find((pattern) => pattern.includes(url));
		});
		await Promise.all(matchingTabs.map(async (tab) => {
			try {
				await browser.tabs.reload(tab.id);
			} catch (err) {
				logger.warn("Failed to reload tab:", err);
			}
		}));
	}
	async function reloadContentScriptMv2(_payload) {
		throw Error("TODO: reloadContentScriptMv2");
	}
	try {
		const ws = getDevServerWebSocket();
		ws.addWxtEventListener("wxt:reload-extension", () => {
			browser.runtime.reload();
		});
		ws.addWxtEventListener("wxt:reload-content-script", (event) => {
			reloadContentScript(event.detail);
		});
		ws.addEventListener("open", () => ws.sendCustom("wxt:background-initialized"));
		keepServiceWorkerAlive();
	} catch (err) {
		logger.error("Failed to setup web socket connection with dev server", err);
	}
	browser.commands.onCommand.addListener((command) => {
		if (command === "wxt:reload-extension") browser.runtime.reload();
	});
	var result;
	try {
		result = background_default.main();
		if (result instanceof Promise) console.warn("The background's main() function return a promise, but it must be synchronous");
	} catch (err) {
		logger.error("The background crashed on startup!");
		throw err;
	}
	return result;
})();

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2dyb3VuZC5qcyIsIm5hbWVzIjpbImJyb3dzZXIiLCJiYWNrZ3JvdW5kX2VudHJ5cG9pbnRfZGVmYXVsdCJdLCJzb3VyY2VzIjpbIi4uLy4uL25vZGVfbW9kdWxlcy93eHQvZGlzdC91dGlscy9kZWZpbmUtYmFja2dyb3VuZC5tanMiLCIuLi8uLi9saWIvY29uZmlnLnRzIiwiLi4vLi4vbGliL2F1dGgudHMiLCIuLi8uLi9saWIvZ21haWwudHMiLCIuLi8uLi9saWIvc2V0dGluZ3MudHMiLCIuLi8uLi9saWIvc3BlZWNoLnRzIiwiLi4vLi4vZW50cnlwb2ludHMvYmFja2dyb3VuZC50cyIsIi4uLy4uL25vZGVfbW9kdWxlcy9Ad3h0LWRldi9icm93c2VyL3NyYy9pbmRleC5tanMiLCIuLi8uLi9ub2RlX21vZHVsZXMvd3h0L2Rpc3QvYnJvd3Nlci5tanMiLCIuLi8uLi9ub2RlX21vZHVsZXMvQHdlYmV4dC1jb3JlL21hdGNoLXBhdHRlcm5zL2xpYi9pbmRleC5tanMiXSwic291cmNlc0NvbnRlbnQiOlsiLy8jcmVnaW9uIHNyYy91dGlscy9kZWZpbmUtYmFja2dyb3VuZC50c1xuZnVuY3Rpb24gZGVmaW5lQmFja2dyb3VuZChhcmcpIHtcblx0aWYgKGFyZyA9PSBudWxsIHx8IHR5cGVvZiBhcmcgPT09IFwiZnVuY3Rpb25cIikgcmV0dXJuIHsgbWFpbjogYXJnIH07XG5cdHJldHVybiBhcmc7XG59XG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IGRlZmluZUJhY2tncm91bmQgfTtcbiIsIi8vIEdvb2dsZSBDbG91ZCBDb25zb2xlIOKGkiBDcmVkZW50aWFscyDihpIgT0F1dGggY2xpZW50IElEIG9mIHR5cGUgXCJXZWIgYXBwbGljYXRpb25cIi5cbi8vIEFkZCB0aGUgcmVkaXJlY3QgVVJJIHByaW50ZWQgYnkgYG5wbSBydW4gZGV2YCAoc2VlIFJFQURNRSkgdG8gdGhhdCBjbGllbnQuXG5leHBvcnQgY29uc3QgR09PR0xFX0NMSUVOVF9JRCA9ICcyNTcyMzAzNTMzOTYtdHVpYTNxbTNpNG40ZHZ2bnRycDFyMjdqb2ZjdTdiMTEuYXBwcy5nb29nbGV1c2VyY29udGVudC5jb20nO1xuIiwiaW1wb3J0IHsgR09PR0xFX0NMSUVOVF9JRCB9IGZyb20gJy4vY29uZmlnJztcblxuY29uc3QgU0NPUEUgPSAnaHR0cHM6Ly93d3cuZ29vZ2xlYXBpcy5jb20vYXV0aC9nbWFpbC5yZWFkb25seSc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2Vzc2lvbiB7XG4gIHRva2VuOiBzdHJpbmc7XG4gIGV4cGlyZXNBdDogbnVtYmVyO1xuICBlbWFpbDogc3RyaW5nO1xufVxuXG5mdW5jdGlvbiBhdXRoVXJsKHByb21wdDogc3RyaW5nLCBsb2dpbkhpbnQ/OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBwID0gbmV3IFVSTFNlYXJjaFBhcmFtcyh7XG4gICAgY2xpZW50X2lkOiBHT09HTEVfQ0xJRU5UX0lELFxuICAgIHJlc3BvbnNlX3R5cGU6ICd0b2tlbicsXG4gICAgcmVkaXJlY3RfdXJpOiBjaHJvbWUuaWRlbnRpdHkuZ2V0UmVkaXJlY3RVUkwoKSxcbiAgICBzY29wZTogU0NPUEUsXG4gICAgcHJvbXB0LFxuICB9KTtcbiAgaWYgKGxvZ2luSGludCkgcC5zZXQoJ2xvZ2luX2hpbnQnLCBsb2dpbkhpbnQpO1xuICByZXR1cm4gYGh0dHBzOi8vYWNjb3VudHMuZ29vZ2xlLmNvbS9vL29hdXRoMi92Mi9hdXRoPyR7cH1gO1xufVxuXG5hc3luYyBmdW5jdGlvbiBydW5GbG93KHVybDogc3RyaW5nLCBpbnRlcmFjdGl2ZTogYm9vbGVhbikge1xuICB0cnkge1xuICAgIGNvbnN0IHJlZGlyZWN0ID0gYXdhaXQgY2hyb21lLmlkZW50aXR5LmxhdW5jaFdlYkF1dGhGbG93KHsgdXJsLCBpbnRlcmFjdGl2ZSB9KTtcbiAgICBpZiAoIXJlZGlyZWN0KSByZXR1cm4gbnVsbDtcbiAgICBjb25zdCBwYXJhbXMgPSBuZXcgVVJMU2VhcmNoUGFyYW1zKG5ldyBVUkwocmVkaXJlY3QpLmhhc2guc2xpY2UoMSkpO1xuICAgIGNvbnN0IHRva2VuID0gcGFyYW1zLmdldCgnYWNjZXNzX3Rva2VuJyk7XG4gICAgaWYgKCF0b2tlbikgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIHsgdG9rZW4sIGV4cGlyZXNBdDogRGF0ZS5ub3coKSArIE51bWJlcihwYXJhbXMuZ2V0KCdleHBpcmVzX2luJykgPz8gMzYwMCkgKiAxMDAwIH07XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGZldGNoRW1haWwodG9rZW46IHN0cmluZyk6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKCdodHRwczovL2dtYWlsLmdvb2dsZWFwaXMuY29tL2dtYWlsL3YxL3VzZXJzL21lL3Byb2ZpbGUnLCB7XG4gICAgaGVhZGVyczogeyBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7dG9rZW59YCB9LFxuICB9KTtcbiAgaWYgKCFyZXMub2spIHRocm93IG5ldyBFcnJvcignQ291bGQgbm90IHJlYWQgR21haWwgcHJvZmlsZScpO1xuICByZXR1cm4gKGF3YWl0IHJlcy5qc29uKCkpLmVtYWlsQWRkcmVzcyBhcyBzdHJpbmc7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRTZXNzaW9uKCk6IFByb21pc2U8U2Vzc2lvbiB8IG51bGw+IHtcbiAgY29uc3QgeyBzZXNzaW9uIH0gPSBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoJ3Nlc3Npb24nKTtcbiAgcmV0dXJuIHNlc3Npb24gPz8gbnVsbDtcbn1cblxuLyoqIE9wZW5zIEdvb2dsZSdzIGFjY291bnQgcGlja2VyLiBSZXNvbHZlcyB0byB0aGUgY29ubmVjdGVkIGVtYWlsLCBvciBudWxsIGlmIGNhbmNlbGxlZC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb25uZWN0KCk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBpZiAoR09PR0xFX0NMSUVOVF9JRC5zdGFydHNXaXRoKCdZT1VSXycpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdBZGQgeW91ciBHb29nbGUgY2xpZW50IElEIGluIGxpYi9jb25maWcudHMgZmlyc3QuJyk7XG4gIH1cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuRmxvdyhhdXRoVXJsKCdzZWxlY3RfYWNjb3VudCcpLCB0cnVlKTtcbiAgaWYgKCFyZXN1bHQpIHJldHVybiBudWxsO1xuXG4gIGNvbnN0IGVtYWlsID0gYXdhaXQgZmV0Y2hFbWFpbChyZXN1bHQudG9rZW4pO1xuICBjb25zdCBwcmV2aW91cyA9IGF3YWl0IGdldFNlc3Npb24oKTtcbiAgaWYgKHByZXZpb3VzICYmIHByZXZpb3VzLmVtYWlsICE9PSBlbWFpbCkgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwucmVtb3ZlKCdzZWVuJyk7XG5cbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgc2Vzc2lvbjogeyAuLi5yZXN1bHQsIGVtYWlsIH0sIGF1dGhlZDogdHJ1ZSB9KTtcbiAgcmV0dXJuIGVtYWlsO1xufVxuXG5sZXQgcmVmcmVzaGluZzogUHJvbWlzZTxzdHJpbmcgfCBudWxsPiB8IG51bGwgPSBudWxsO1xuXG5hc3luYyBmdW5jdGlvbiByZWZyZXNoKGVtYWlsOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZyB8IG51bGw+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuRmxvdyhhdXRoVXJsKCdub25lJywgZW1haWwpLCBmYWxzZSk7XG4gIGlmICghcmVzdWx0KSB7XG4gICAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgYXV0aGVkOiBmYWxzZSB9KTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBzZXNzaW9uOiB7IC4uLnJlc3VsdCwgZW1haWwgfSwgYXV0aGVkOiB0cnVlIH0pO1xuICByZXR1cm4gcmVzdWx0LnRva2VuO1xufVxuXG4vKiogQSB2YWxpZCBhY2Nlc3MgdG9rZW4sIHJlbmV3ZWQgc2lsZW50bHkgd2hlbiBpdCBoYXMgZXhwaXJlZC4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRUb2tlbihmb3JjZVJlZnJlc2ggPSBmYWxzZSk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD4ge1xuICBjb25zdCBzZXNzaW9uID0gYXdhaXQgZ2V0U2Vzc2lvbigpO1xuICBpZiAoIXNlc3Npb24pIHJldHVybiBudWxsO1xuICBpZiAoIWZvcmNlUmVmcmVzaCAmJiBzZXNzaW9uLmV4cGlyZXNBdCAtIERhdGUubm93KCkgPiA2MF8wMDApIHJldHVybiBzZXNzaW9uLnRva2VuO1xuICByZWZyZXNoaW5nID8/PSByZWZyZXNoKHNlc3Npb24uZW1haWwpLmZpbmFsbHkoKCkgPT4gKHJlZnJlc2hpbmcgPSBudWxsKSk7XG4gIHJldHVybiByZWZyZXNoaW5nO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZGlzY29ubmVjdCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc2Vzc2lvbiA9IGF3YWl0IGdldFNlc3Npb24oKTtcbiAgaWYgKHNlc3Npb24pIHtcbiAgICBmZXRjaChgaHR0cHM6Ly9vYXV0aDIuZ29vZ2xlYXBpcy5jb20vcmV2b2tlP3Rva2VuPSR7c2Vzc2lvbi50b2tlbn1gLCB7IG1ldGhvZDogJ1BPU1QnIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgfVxuICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5yZW1vdmUoWydzZXNzaW9uJywgJ3NlZW4nLCAnbGFzdENoZWNrJywgJ3NwZWFraW5nJ10pO1xuICBhd2FpdCBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBhdXRoZWQ6IGZhbHNlIH0pO1xufVxuIiwiaW1wb3J0IHsgZ2V0VG9rZW4gfSBmcm9tICcuL2F1dGgnO1xuXG5jb25zdCBBUEkgPSAnaHR0cHM6Ly9nbWFpbC5nb29nbGVhcGlzLmNvbS9nbWFpbC92MS91c2Vycy9tZSc7XG5cbmFzeW5jIGZ1bmN0aW9uIGFwaTxUPihwYXRoOiBzdHJpbmcsIHJldHJ5ID0gdHJ1ZSk6IFByb21pc2U8VD4ge1xuICBjb25zdCB0b2tlbiA9IGF3YWl0IGdldFRva2VuKCk7XG4gIGlmICghdG9rZW4pIHRocm93IG5ldyBFcnJvcignTm90IGNvbm5lY3RlZCcpO1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChgJHtBUEl9JHtwYXRofWAsIHsgaGVhZGVyczogeyBBdXRob3JpemF0aW9uOiBgQmVhcmVyICR7dG9rZW59YCB9IH0pO1xuICBpZiAocmVzLnN0YXR1cyA9PT0gNDAxICYmIHJldHJ5KSB7XG4gICAgYXdhaXQgZ2V0VG9rZW4odHJ1ZSk7XG4gICAgcmV0dXJuIGFwaTxUPihwYXRoLCBmYWxzZSk7XG4gIH1cbiAgaWYgKCFyZXMub2spIHRocm93IG5ldyBFcnJvcihgR21haWwgQVBJICR7cmVzLnN0YXR1c31gKTtcbiAgcmV0dXJuIHJlcy5qc29uKCkgYXMgUHJvbWlzZTxUPjtcbn1cblxuLyoqIFVucmVhZCBtZXNzYWdlIElEcyBmcm9tIGFueSBvZiB0aGUgc2VuZGVycywgbmV3ZXN0IGZpcnN0LiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxpc3RVbnJlYWQoc2VuZGVyczogc3RyaW5nW10pOiBQcm9taXNlPHN0cmluZ1tdPiB7XG4gIGNvbnN0IGZyb20gPSBzZW5kZXJzLm1hcCgocykgPT4gYGZyb206JHtzfWApLmpvaW4oJyBPUiAnKTtcbiAgY29uc3QgcSA9IGVuY29kZVVSSUNvbXBvbmVudChgKCR7ZnJvbX0pIGlzOnVucmVhZCBuZXdlcl90aGFuOjJkYCk7XG4gIGNvbnN0IGRhdGEgPSBhd2FpdCBhcGk8eyBtZXNzYWdlcz86IHsgaWQ6IHN0cmluZyB9W10gfT4oYC9tZXNzYWdlcz9xPSR7cX0mbWF4UmVzdWx0cz0xMGApO1xuICByZXR1cm4gKGRhdGEubWVzc2FnZXMgPz8gW10pLm1hcCgobSkgPT4gbS5pZCk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRW1haWwge1xuICBpZDogc3RyaW5nO1xuICBmcm9tTmFtZTogc3RyaW5nO1xuICBzdWJqZWN0OiBzdHJpbmc7XG4gIGJvZHk6IHN0cmluZztcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEVtYWlsKGlkOiBzdHJpbmcpOiBQcm9taXNlPEVtYWlsPiB7XG4gIGNvbnN0IG1zZyA9IGF3YWl0IGFwaTxhbnk+KGAvbWVzc2FnZXMvJHtpZH0/Zm9ybWF0PWZ1bGxgKTtcbiAgY29uc3QgaGVhZGVyczogeyBuYW1lOiBzdHJpbmc7IHZhbHVlOiBzdHJpbmcgfVtdID0gbXNnLnBheWxvYWQ/LmhlYWRlcnMgPz8gW107XG4gIGNvbnN0IGggPSAobjogc3RyaW5nKSA9PiBoZWFkZXJzLmZpbmQoKHgpID0+IHgubmFtZS50b0xvd2VyQ2FzZSgpID09PSBuKT8udmFsdWUgPz8gJyc7XG5cbiAgY29uc3QgZnJvbSA9IGgoJ2Zyb20nKTtcbiAgY29uc3QgZnJvbU5hbWUgPSBmcm9tLm1hdGNoKC9eXCI/KFteXCI8XSs/KVwiP1xccyo8Lyk/LlsxXT8udHJpbSgpIHx8IGZyb20ucmVwbGFjZSgvPC4qPi8sICcnKS50cmltKCkgfHwgJ3Vua25vd24gc2VuZGVyJztcblxuICByZXR1cm4ge1xuICAgIGlkLFxuICAgIGZyb21OYW1lLFxuICAgIHN1YmplY3Q6IGgoJ3N1YmplY3QnKSB8fCAnbm8gc3ViamVjdCcsXG4gICAgYm9keTogZXh0cmFjdEJvZHkobXNnLnBheWxvYWQpLFxuICB9O1xufVxuXG5mdW5jdGlvbiBkZWNvZGUoZGF0YTogc3RyaW5nKTogc3RyaW5nIHtcbiAgY29uc3QgYmluID0gYXRvYihkYXRhLnJlcGxhY2UoLy0vZywgJysnKS5yZXBsYWNlKC9fL2csICcvJykpO1xuICByZXR1cm4gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKFVpbnQ4QXJyYXkuZnJvbShiaW4sIChjKSA9PiBjLmNoYXJDb2RlQXQoMCkpKTtcbn1cblxuZnVuY3Rpb24gZmluZFBhcnQocGFydDogYW55LCBtaW1lOiBzdHJpbmcpOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFwYXJ0KSByZXR1cm4gbnVsbDtcbiAgaWYgKHBhcnQubWltZVR5cGUgPT09IG1pbWUgJiYgcGFydC5ib2R5Py5kYXRhKSByZXR1cm4gZGVjb2RlKHBhcnQuYm9keS5kYXRhKTtcbiAgZm9yIChjb25zdCBwIG9mIHBhcnQucGFydHMgPz8gW10pIHtcbiAgICBjb25zdCBmb3VuZCA9IGZpbmRQYXJ0KHAsIG1pbWUpO1xuICAgIGlmIChmb3VuZCkgcmV0dXJuIGZvdW5kO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBleHRyYWN0Qm9keShwYXlsb2FkOiBhbnkpOiBzdHJpbmcge1xuICBjb25zdCBwbGFpbiA9IGZpbmRQYXJ0KHBheWxvYWQsICd0ZXh0L3BsYWluJyk7XG4gIGlmIChwbGFpbikgcmV0dXJuIGNsZWFuKHBsYWluKTtcbiAgY29uc3QgaHRtbCA9IGZpbmRQYXJ0KHBheWxvYWQsICd0ZXh0L2h0bWwnKTtcbiAgcmV0dXJuIGh0bWwgPyBjbGVhbihzdHJpcEh0bWwoaHRtbCkpIDogJyc7XG59XG5cbmZ1bmN0aW9uIHN0cmlwSHRtbChodG1sOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gaHRtbFxuICAgIC5yZXBsYWNlKC88KHN0eWxlfHNjcmlwdHxoZWFkKVtcXHNcXFNdKj88XFwvXFwxPi9naSwgJyAnKVxuICAgIC5yZXBsYWNlKC88YnJcXHMqXFwvPz58PFxcLyhwfGRpdnxsaXx0cnxoXFxkKT4vZ2ksICdcXG4nKVxuICAgIC5yZXBsYWNlKC88W14+XSs+L2csICcgJylcbiAgICAucmVwbGFjZSgvJm5ic3A7L2csICcgJylcbiAgICAucmVwbGFjZSgvJmFtcDsvZywgJyYnKVxuICAgIC5yZXBsYWNlKC8mbHQ7L2csICc8JylcbiAgICAucmVwbGFjZSgvJmd0Oy9nLCAnPicpXG4gICAgLnJlcGxhY2UoLyYjMzk7fCZhcG9zOy9nLCBcIidcIilcbiAgICAucmVwbGFjZSgvJnF1b3Q7L2csICdcIicpO1xufVxuXG4vKiogTWFrZSBhbiBlbWFpbCBwbGVhc2FudCB0byBsaXN0ZW4gdG86IGRyb3AgbGlua3MsIHF1b3RlZCByZXBsaWVzIGFuZCBmb290ZXJzLiAqL1xuZnVuY3Rpb24gY2xlYW4odGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHRcbiAgICAuc3BsaXQoL1xcbig/Ok9uIC4rIHdyb3RlOnwtezIsfVxccypPcmlnaW5hbCBNZXNzYWdlfFVuc3Vic2NyaWJlfFlvdSByZWNlaXZlZCB0aGlzIGVtYWlsKS9pKVswXVxuICAgIC5yZXBsYWNlKC9ePi4qJC9nbSwgJycpXG4gICAgLnJlcGxhY2UoL2h0dHBzPzpcXC9cXC9cXFMrL2csICcnKVxuICAgIC5yZXBsYWNlKC9bIFxcdF0rL2csICcgJylcbiAgICAucmVwbGFjZSgvXFxuezIsfS9nLCAnLiAnKVxuICAgIC5yZXBsYWNlKC9cXHMqXFxuXFxzKi9nLCAnICcpXG4gICAgLnRyaW0oKTtcbn1cbiIsImV4cG9ydCBpbnRlcmZhY2UgU2V0dGluZ3Mge1xuICBlbmFibGVkOiBib29sZWFuO1xuICBzZW5kZXJzOiBzdHJpbmdbXTsgLy8gZG9tYWlucywgYWRkcmVzc2VzIG9yIG5hbWVzLCBlLmcuIFwibWVyY29yLmNvbVwiXG4gIHJhdGU6IG51bWJlcjsgLy8gc3BlZWNoIHNwZWVkLCAwLjcg4oCTIDEuNlxuICBtb2RlOiAnc2hvcnQnIHwgJ2Z1bGwnO1xufVxuXG5leHBvcnQgY29uc3QgREVGQVVMVFM6IFNldHRpbmdzID0ge1xuICBlbmFibGVkOiB0cnVlLFxuICBzZW5kZXJzOiBbXSxcbiAgcmF0ZTogMSxcbiAgbW9kZTogJ3Nob3J0Jyxcbn07XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRTZXR0aW5ncygpOiBQcm9taXNlPFNldHRpbmdzPiB7XG4gIGNvbnN0IHsgc2V0dGluZ3MgfSA9IGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldCgnc2V0dGluZ3MnKTtcbiAgcmV0dXJuIHsgLi4uREVGQVVMVFMsIC4uLihzZXR0aW5ncyA/PyB7fSkgfTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNhdmVTZXR0aW5ncyhwYXRjaDogUGFydGlhbDxTZXR0aW5ncz4pOiBQcm9taXNlPFNldHRpbmdzPiB7XG4gIGNvbnN0IG5leHQgPSB7IC4uLihhd2FpdCBnZXRTZXR0aW5ncygpKSwgLi4ucGF0Y2ggfTtcbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgc2V0dGluZ3M6IG5leHQgfSk7XG4gIHJldHVybiBuZXh0O1xufVxuXG4vKiogSURzIG9mIG1lc3NhZ2VzIGFscmVhZHkgaGFuZGxlZC4gYG51bGxgIG1lYW5zIGZpcnN0IHJ1biAobm8gYmFzZWxpbmUgeWV0KS4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRTZWVuKCk6IFByb21pc2U8c3RyaW5nW10gfCBudWxsPiB7XG4gIGNvbnN0IHsgc2VlbiB9ID0gYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KCdzZWVuJyk7XG4gIHJldHVybiBBcnJheS5pc0FycmF5KHNlZW4pID8gc2VlbiA6IG51bGw7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzZXRTZWVuKGlkczogc3RyaW5nW10pOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgc2VlbjogaWRzLnNsaWNlKC0yMDApIH0pO1xufVxuIiwiZXhwb3J0IGZ1bmN0aW9uIHNwZWFrKHRleHQ6IHN0cmluZywgcmF0ZTogbnVtYmVyKTogdm9pZCB7XG4gIGNocm9tZS50dHMuc3BlYWsodGV4dC5zbGljZSgwLCA1MDAwKSwge1xuICAgIHJhdGUsXG4gICAgZW5xdWV1ZTogdHJ1ZSxcbiAgICBvbkV2ZW50OiAoZSkgPT4ge1xuICAgICAgaWYgKGUudHlwZSA9PT0gJ3N0YXJ0JykgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgc3BlYWtpbmc6IHRydWUgfSk7XG4gICAgICBpZiAoWydlbmQnLCAnaW50ZXJydXB0ZWQnLCAnY2FuY2VsbGVkJywgJ2Vycm9yJ10uaW5jbHVkZXMoZS50eXBlKSkge1xuICAgICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBzcGVha2luZzogZmFsc2UgfSk7XG4gICAgICB9XG4gICAgfSxcbiAgfSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzdG9wKCk6IHZvaWQge1xuICBjaHJvbWUudHRzLnN0b3AoKTtcbiAgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgc3BlYWtpbmc6IGZhbHNlIH0pO1xufVxuIiwiaW1wb3J0IHsgZ2V0VG9rZW4gfSBmcm9tICdAL2xpYi9hdXRoJztcbmltcG9ydCB7IGdldEVtYWlsLCBsaXN0VW5yZWFkIH0gZnJvbSAnQC9saWIvZ21haWwnO1xuaW1wb3J0IHsgZ2V0U2VlbiwgZ2V0U2V0dGluZ3MsIHNldFNlZW4gfSBmcm9tICdAL2xpYi9zZXR0aW5ncyc7XG5pbXBvcnQgeyBzcGVhayB9IGZyb20gJ0AvbGliL3NwZWVjaCc7XG5cbmNvbnN0IEFMQVJNID0gJ2hhcmstcG9sbCc7XG5jb25zdCBTSE9SVF9MSU1JVCA9IDUwMDtcbmNvbnN0IEZVTExfTElNSVQgPSA0MDAwO1xuXG5sZXQgcG9sbGluZyA9IGZhbHNlO1xuXG5hc3luYyBmdW5jdGlvbiBwb2xsKCkge1xuICBpZiAocG9sbGluZykgcmV0dXJuO1xuICBwb2xsaW5nID0gdHJ1ZTtcbiAgdHJ5IHtcbiAgICBjb25zdCBzID0gYXdhaXQgZ2V0U2V0dGluZ3MoKTtcbiAgICBpZiAoIXMuZW5hYmxlZCB8fCBzLnNlbmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgaWYgKCEoYXdhaXQgZ2V0VG9rZW4oKSkpIHJldHVybjtcblxuICAgIGNvbnN0IGlkcyA9IGF3YWl0IGxpc3RVbnJlYWQocy5zZW5kZXJzKTsgLy8gbmV3ZXN0IGZpcnN0XG4gICAgY29uc3Qgc2VlbiA9IGF3YWl0IGdldFNlZW4oKTtcblxuICAgIC8vIEZpcnN0IHJ1bjogcmVtZW1iZXIgd2hhdCBpcyBhbHJlYWR5IGluIHRoZSBpbmJveCwgZG9uJ3QgcmVhZCBpdCBhbGwgb3V0LlxuICAgIGlmIChzZWVuID09PSBudWxsKSB7XG4gICAgICBhd2FpdCBzZXRTZWVuKGlkcyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgZnJlc2ggPSBpZHMuZmlsdGVyKChpZCkgPT4gIXNlZW4uaW5jbHVkZXMoaWQpKS5yZXZlcnNlKCk7IC8vIG9sZGVzdCBmaXJzdFxuICAgIGZvciAoY29uc3QgaWQgb2YgZnJlc2gpIHtcbiAgICAgIGNvbnN0IG1haWwgPSBhd2FpdCBnZXRFbWFpbChpZCk7XG4gICAgICBjb25zdCBsaW1pdCA9IHMubW9kZSA9PT0gJ2Z1bGwnID8gRlVMTF9MSU1JVCA6IFNIT1JUX0xJTUlUO1xuICAgICAgY29uc3QgYm9keSA9IG1haWwuYm9keS5sZW5ndGggPiBsaW1pdCA/IG1haWwuYm9keS5zbGljZSgwLCBsaW1pdCkgKyAn4oCmJyA6IG1haWwuYm9keTtcbiAgICAgIHNwZWFrKGBOZXcgZW1haWwgZnJvbSAke21haWwuZnJvbU5hbWV9LiBTdWJqZWN0OiAke21haWwuc3ViamVjdH0uICR7Ym9keX1gLCBzLnJhdGUpO1xuICAgICAgc2Vlbi5wdXNoKGlkKTtcbiAgICAgIGF3YWl0IHNldFNlZW4oc2Vlbik7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zb2xlLmVycm9yKCdbSGFya10gcG9sbCBmYWlsZWQnLCBlcnIpO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IGxhc3RDaGVjazogRGF0ZS5ub3coKSB9KTtcbiAgICBwb2xsaW5nID0gZmFsc2U7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQmFja2dyb3VuZCgoKSA9PiB7XG4gIGNocm9tZS5hbGFybXMuY3JlYXRlKEFMQVJNLCB7IGRlbGF5SW5NaW51dGVzOiAwLjEsIHBlcmlvZEluTWludXRlczogMSB9KTtcbiAgY2hyb21lLmFsYXJtcy5vbkFsYXJtLmFkZExpc3RlbmVyKChhKSA9PiBhLm5hbWUgPT09IEFMQVJNICYmIHBvbGwoKSk7XG4gIGNocm9tZS5ydW50aW1lLm9uU3RhcnR1cC5hZGRMaXN0ZW5lcigoKSA9PiBwb2xsKCkpO1xuXG4gIGNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihhc3luYyAobXNnKSA9PiB7XG4gICAgaWYgKG1zZz8udHlwZSA9PT0gJ2NoZWNrJykgcG9sbCgpO1xuICAgIGlmIChtc2c/LnR5cGUgPT09ICd0ZXN0Jykge1xuICAgICAgY29uc3QgcyA9IGF3YWl0IGdldFNldHRpbmdzKCk7XG4gICAgICBzcGVhaygnTmV3IGVtYWlsLiBTdWJqZWN0OiBZb3VyIG5leHQgcHJvamVjdCBpcyByZWFkeS4gVGhpcyBpcyBob3cgSGFyayB3aWxsIHNvdW5kLicsIHMucmF0ZSk7XG4gICAgfVxuICB9KTtcbn0pO1xuIiwiLy8gI3JlZ2lvbiBzbmlwcGV0XG5leHBvcnQgY29uc3QgYnJvd3NlciA9IGdsb2JhbFRoaXMuYnJvd3Nlcj8ucnVudGltZT8uaWRcbiAgPyBnbG9iYWxUaGlzLmJyb3dzZXJcbiAgOiBnbG9iYWxUaGlzLmNocm9tZTtcbi8vICNlbmRyZWdpb24gc25pcHBldFxuIiwiaW1wb3J0IHsgYnJvd3NlciBhcyBicm93c2VyJDEgfSBmcm9tIFwiQHd4dC1kZXYvYnJvd3NlclwiO1xuLy8jcmVnaW9uIHNyYy9icm93c2VyLnRzXG4vKipcbiogQ29udGFpbnMgdGhlIGBicm93c2VyYCBleHBvcnQgd2hpY2ggeW91IHNob3VsZCB1c2UgdG8gYWNjZXNzIHRoZSBleHRlbnNpb25cbiogQVBJcyBpbiB5b3VyIHByb2plY3Q6XG4qXG4qIGBgYHRzXG4qIGltcG9ydCB7IGJyb3dzZXIgfSBmcm9tICd3eHQvYnJvd3Nlcic7XG4qXG4qIGJyb3dzZXIucnVudGltZS5vbkluc3RhbGxlZC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4qICAgLy8gLi4uXG4qIH0pO1xuKiBgYGBcbipcbiogQG1vZHVsZSB3eHQvYnJvd3NlclxuKi9cbmNvbnN0IGJyb3dzZXIgPSBicm93c2VyJDE7XG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IGJyb3dzZXIgfTtcbiIsIi8vI3JlZ2lvbiBzcmMvaW5kZXgudHNcbi8qKlxuKiBDbGFzcyBmb3IgcGFyc2luZyBhbmQgcGVyZm9ybWluZyBvcGVyYXRpb25zIG9uIG1hdGNoIHBhdHRlcm5zLlxuKlxuKiBAZXhhbXBsZVxuKiAgIGNvbnN0IHBhdHRlcm4gPSBuZXcgTWF0Y2hQYXR0ZXJuKCcqOi8vZ29vZ2xlLmNvbS8qJyk7XG4qXG4qICAgcGF0dGVybi5pbmNsdWRlcygnaHR0cHM6Ly9nb29nbGUuY29tJyk7IC8vIHRydWVcbiogICBwYXR0ZXJuLmluY2x1ZGVzKCdodHRwOi8veW91dHViZS5jb20vd2F0Y2g/dj0xMjMnKTsgLy8gZmFsc2VcbiovXG52YXIgTWF0Y2hQYXR0ZXJuID0gY2xhc3MgTWF0Y2hQYXR0ZXJuIHtcblx0c3RhdGljIHtcblx0XHR0aGlzLlBST1RPQ09MUyA9IFtcblx0XHRcdFwiaHR0cFwiLFxuXHRcdFx0XCJodHRwc1wiLFxuXHRcdFx0XCJmaWxlXCIsXG5cdFx0XHRcImZ0cFwiLFxuXHRcdFx0XCJ1cm5cIixcblx0XHRcdFwid3NcIixcblx0XHRcdFwid3NzXCJcblx0XHRdO1xuXHR9XG5cdC8qKlxuXHQqIFBhcnNlIGEgbWF0Y2ggcGF0dGVybiBzdHJpbmcuIElmIGl0IGlzIGludmFsaWQsIHRoZSBjb25zdHJ1Y3RvciB3aWxsIHRocm93IGFuXG5cdCogYEludmFsaWRNYXRjaFBhdHRlcm5gIGVycm9yLlxuXHQqXG5cdCogQHBhcmFtIG1hdGNoUGF0dGVybiBUaGUgbWF0Y2ggcGF0dGVybiB0byBwYXJzZS5cblx0Ki9cblx0Y29uc3RydWN0b3IobWF0Y2hQYXR0ZXJuKSB7XG5cdFx0aWYgKG1hdGNoUGF0dGVybiA9PT0gXCI8YWxsX3VybHM+XCIpIHtcblx0XHRcdHRoaXMuaXNBbGxVcmxzID0gdHJ1ZTtcblx0XHRcdHRoaXMucHJvdG9jb2xNYXRjaGVzID0gWy4uLk1hdGNoUGF0dGVybi5QUk9UT0NPTFNdO1xuXHRcdFx0dGhpcy5ob3N0bmFtZU1hdGNoID0gXCIqXCI7XG5cdFx0XHR0aGlzLnBhdGhuYW1lTWF0Y2ggPSBcIipcIjtcblx0XHR9IGVsc2Uge1xuXHRcdFx0Y29uc3QgZ3JvdXBzID0gLyguKik6XFwvXFwvKC4qPykoXFwvLiopLy5leGVjKG1hdGNoUGF0dGVybik7XG5cdFx0XHRpZiAoZ3JvdXBzID09IG51bGwpIHRocm93IG5ldyBJbnZhbGlkTWF0Y2hQYXR0ZXJuKG1hdGNoUGF0dGVybiwgXCJJbmNvcnJlY3QgZm9ybWF0XCIpO1xuXHRcdFx0Y29uc3QgW18sIHByb3RvY29sLCBob3N0bmFtZSwgcGF0aG5hbWVdID0gZ3JvdXBzO1xuXHRcdFx0dmFsaWRhdGVQcm90b2NvbChtYXRjaFBhdHRlcm4sIHByb3RvY29sKTtcblx0XHRcdHZhbGlkYXRlSG9zdG5hbWUobWF0Y2hQYXR0ZXJuLCBob3N0bmFtZSk7XG5cdFx0XHR0aGlzLnByb3RvY29sTWF0Y2hlcyA9IHByb3RvY29sID09PSBcIipcIiA/IFtcImh0dHBcIiwgXCJodHRwc1wiXSA6IFtwcm90b2NvbF07XG5cdFx0XHR0aGlzLmhvc3RuYW1lTWF0Y2ggPSBob3N0bmFtZTtcblx0XHRcdHRoaXMucGF0aG5hbWVNYXRjaCA9IHBhdGhuYW1lO1xuXHRcdH1cblx0fVxuXHQvKiogQ2hlY2sgaWYgYSBVUkwgaXMgaW5jbHVkZWQgaW4gYSBwYXR0ZXJuLiAqL1xuXHRpbmNsdWRlcyh1cmwpIHtcblx0XHRjb25zdCB1ID0gdHlwZW9mIHVybCA9PT0gXCJzdHJpbmdcIiA/IG5ldyBVUkwodXJsKSA6IHVybCBpbnN0YW5jZW9mIExvY2F0aW9uID8gbmV3IFVSTCh1cmwuaHJlZikgOiB1cmw7XG5cdFx0aWYgKHRoaXMuaXNBbGxVcmxzKSByZXR1cm4gIXRoaXMuaXNVbmtub3duUHJvdG9jb2wodSk7XG5cdFx0cmV0dXJuICEhdGhpcy5wcm90b2NvbE1hdGNoZXMuZmluZCgocHJvdG9jb2wpID0+IHtcblx0XHRcdGlmIChwcm90b2NvbCA9PT0gXCJodHRwXCIpIHJldHVybiB0aGlzLmlzSHR0cE1hdGNoKHUpO1xuXHRcdFx0aWYgKHByb3RvY29sID09PSBcImh0dHBzXCIpIHJldHVybiB0aGlzLmlzSHR0cHNNYXRjaCh1KTtcblx0XHRcdGlmIChwcm90b2NvbCA9PT0gXCJmaWxlXCIpIHJldHVybiB0aGlzLmlzRmlsZU1hdGNoKHUpO1xuXHRcdFx0aWYgKHByb3RvY29sID09PSBcImZ0cFwiKSByZXR1cm4gdGhpcy5pc0Z0cE1hdGNoKHUpO1xuXHRcdFx0aWYgKHByb3RvY29sID09PSBcInVyblwiKSByZXR1cm4gdGhpcy5pc1Vybk1hdGNoKHUpO1xuXHRcdH0pO1xuXHR9XG5cdGlzSHR0cE1hdGNoKHVybCkge1xuXHRcdHJldHVybiB1cmwucHJvdG9jb2wgPT09IFwiaHR0cDpcIiAmJiB0aGlzLmlzSG9zdFBhdGhNYXRjaCh1cmwpO1xuXHR9XG5cdGlzSHR0cHNNYXRjaCh1cmwpIHtcblx0XHRyZXR1cm4gdXJsLnByb3RvY29sID09PSBcImh0dHBzOlwiICYmIHRoaXMuaXNIb3N0UGF0aE1hdGNoKHVybCk7XG5cdH1cblx0aXNIb3N0UGF0aE1hdGNoKHVybCkge1xuXHRcdGlmICghdGhpcy5ob3N0bmFtZU1hdGNoIHx8ICF0aGlzLnBhdGhuYW1lTWF0Y2gpIHJldHVybiBmYWxzZTtcblx0XHRjb25zdCBob3N0bmFtZU1hdGNoUmVnZXhzID0gW3RoaXMuY29udmVydFBhdHRlcm5Ub1JlZ2V4KHRoaXMuaG9zdG5hbWVNYXRjaCksIHRoaXMuY29udmVydFBhdHRlcm5Ub1JlZ2V4KHRoaXMuaG9zdG5hbWVNYXRjaC5yZXBsYWNlKC9eXFwqXFwuLywgXCJcIikpXTtcblx0XHRjb25zdCBwYXRobmFtZU1hdGNoUmVnZXggPSB0aGlzLmNvbnZlcnRQYXR0ZXJuVG9SZWdleCh0aGlzLnBhdGhuYW1lTWF0Y2gpO1xuXHRcdHJldHVybiAhIWhvc3RuYW1lTWF0Y2hSZWdleHMuZmluZCgocmVnZXgpID0+IHJlZ2V4LnRlc3QodXJsLmhvc3RuYW1lKSkgJiYgcGF0aG5hbWVNYXRjaFJlZ2V4LnRlc3QodXJsLnBhdGhuYW1lKTtcblx0fVxuXHRpc1Vua25vd25Qcm90b2NvbCh1cmwpIHtcblx0XHRyZXR1cm4gIXRoaXMucHJvdG9jb2xNYXRjaGVzLmluY2x1ZGVzKHVybC5wcm90b2NvbC5zbGljZSgwLCAtMSkpO1xuXHR9XG5cdGlzUGF0aE1hdGNoKHVybCkge1xuXHRcdGlmICghdGhpcy5wYXRobmFtZU1hdGNoKSByZXR1cm4gZmFsc2U7XG5cdFx0cmV0dXJuIHRoaXMuY29udmVydFBhdHRlcm5Ub1JlZ2V4KHRoaXMucGF0aG5hbWVNYXRjaCkudGVzdCh1cmwucGF0aG5hbWUpO1xuXHR9XG5cdGlzRmlsZU1hdGNoKHVybCkge1xuXHRcdHJldHVybiB1cmwucHJvdG9jb2wgPT09IFwiZmlsZTpcIiAmJiB0aGlzLmlzUGF0aE1hdGNoKHVybCk7XG5cdH1cblx0aXNGdHBNYXRjaChfdXJsKSB7XG5cdFx0dGhyb3cgRXJyb3IoXCJOb3QgaW1wbGVtZW50ZWQ6IGZ0cDovLyBwYXR0ZXJuIG1hdGNoaW5nLiBPcGVuIGEgUFIgdG8gYWRkIHN1cHBvcnRcIik7XG5cdH1cblx0aXNVcm5NYXRjaChfdXJsKSB7XG5cdFx0dGhyb3cgRXJyb3IoXCJOb3QgaW1wbGVtZW50ZWQ6IHVybjovLyBwYXR0ZXJuIG1hdGNoaW5nLiBPcGVuIGEgUFIgdG8gYWRkIHN1cHBvcnRcIik7XG5cdH1cblx0Y29udmVydFBhdHRlcm5Ub1JlZ2V4KHBhdHRlcm4pIHtcblx0XHRjb25zdCBzdGFyc1JlcGxhY2VkID0gdGhpcy5lc2NhcGVGb3JSZWdleChwYXR0ZXJuKS5yZXBsYWNlKC9cXFxcXFwqL2csIFwiLipcIik7XG5cdFx0cmV0dXJuIFJlZ0V4cChgXiR7c3RhcnNSZXBsYWNlZH0kYCk7XG5cdH1cblx0ZXNjYXBlRm9yUmVnZXgoc3RyaW5nKSB7XG5cdFx0cmV0dXJuIHN0cmluZy5yZXBsYWNlKC9bLiorP14ke30oKXxbXFxdXFxcXF0vZywgXCJcXFxcJCZcIik7XG5cdH1cbn07XG52YXIgSW52YWxpZE1hdGNoUGF0dGVybiA9IGNsYXNzIGV4dGVuZHMgRXJyb3Ige1xuXHRjb25zdHJ1Y3RvcihtYXRjaFBhdHRlcm4sIHJlYXNvbikge1xuXHRcdHN1cGVyKGBJbnZhbGlkIG1hdGNoIHBhdHRlcm4gXCIke21hdGNoUGF0dGVybn1cIjogJHtyZWFzb259YCk7XG5cdH1cbn07XG5mdW5jdGlvbiB2YWxpZGF0ZVByb3RvY29sKG1hdGNoUGF0dGVybiwgcHJvdG9jb2wpIHtcblx0aWYgKCFNYXRjaFBhdHRlcm4uUFJPVE9DT0xTLmluY2x1ZGVzKHByb3RvY29sKSAmJiBwcm90b2NvbCAhPT0gXCIqXCIpIHRocm93IG5ldyBJbnZhbGlkTWF0Y2hQYXR0ZXJuKG1hdGNoUGF0dGVybiwgYCR7cHJvdG9jb2x9IG5vdCBhIHZhbGlkIHByb3RvY29sICgke01hdGNoUGF0dGVybi5QUk9UT0NPTFMuam9pbihcIiwgXCIpfSlgKTtcbn1cbmZ1bmN0aW9uIHZhbGlkYXRlSG9zdG5hbWUobWF0Y2hQYXR0ZXJuLCBob3N0bmFtZSkge1xuXHRpZiAoaG9zdG5hbWUuaW5jbHVkZXMoXCI6XCIpKSB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihtYXRjaFBhdHRlcm4sIGBIb3N0bmFtZSBjYW5ub3QgaW5jbHVkZSBhIHBvcnRgKTtcblx0aWYgKGhvc3RuYW1lLmluY2x1ZGVzKFwiKlwiKSAmJiBob3N0bmFtZS5sZW5ndGggPiAxICYmICFob3N0bmFtZS5zdGFydHNXaXRoKFwiKi5cIikpIHRocm93IG5ldyBJbnZhbGlkTWF0Y2hQYXR0ZXJuKG1hdGNoUGF0dGVybiwgYElmIHVzaW5nIGEgd2lsZGNhcmQgKCopLCBpdCBtdXN0IGdvIGF0IHRoZSBzdGFydCBvZiB0aGUgaG9zdG5hbWVgKTtcbn1cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgSW52YWxpZE1hdGNoUGF0dGVybiwgTWF0Y2hQYXR0ZXJuIH07XG4iXSwiaWdub3JlTGlzdCI6WzAsNyw4LDldLCJtYXBwaW5ncyI6Ijs7Q0FDQSxTQUFTLGlCQUFpQixLQUFLO0VBQzlCLElBQUksT0FBTyxRQUFRLE9BQU8sUUFBUSxZQUFZLE9BQU8sRUFBRSxNQUFNLElBQUk7RUFDakUs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