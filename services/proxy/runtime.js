/**
 * makeUrlUtils returns URL helper functions bound to a proxy prefix.
 *
 * @param {object} opts
 * @param {string} opts.proxyPrefix  - e.g. "/api/v1/proxy"
 * @param {() => string} [opts.getOrigin] - returns current origin; defaults to "http://localhost"
 */
function makeUrlUtils({ proxyPrefix, getOrigin = () => "http://localhost" }) {
    const SPECIAL_PROTOCOLS = [
        "data:",
        "blob:",
        "javascript:",
        "mailto:",
        "tel:",
        "about:",
    ];

    function isSpecialProtocol(url) {
        return (
            typeof url === "string" &&
            SPECIAL_PROTOCOLS.some(prefix => url.startsWith(prefix))
        );
    }

    /**
     * Extracts and reconstructs the original target URL from a proxy-formatted URL.
     * Returns null if the URL does not contain the expected proxy prefix.
     *
     * e.g., converts "/<PROXY_PREFIX>/https/example.com/path?query=1"
     * back to "https://example.com/path?query=1".
     */
    function inferTargetUrl(candidate) {
        try {
            const parsed = new URL(candidate, getOrigin());
            const regex = new RegExp(`^${proxyPrefix}/([^/]+)/(.*)`);
            const match = regex.exec(parsed.pathname);
            if (!match) return null;
            const [_, scheme, remainder] = match;
            return new URL(
                `${scheme}://${remainder}${parsed.search}${parsed.hash}`,
            );
        } catch (_error) {
            return null;
        }
    }

    /**
     * Converts an input URL or Request object into an absolute target URL.
     * Returns fragments (e.g., "#hash") and special protocols (e.g., "mailto:") unchanged.
     * Unwraps existing proxy URLs to their original target, and resolves relative
     * paths against the provided base URL.
     */
    function toTargetUrl(input, base) {
        if (!input) return null;
        try {
            const value = typeof input === "string" ? input : input.url;
            if (!value || value.startsWith("#") || isSpecialProtocol(value))
                return value;
            const target = inferTargetUrl(value);
            if (target) return target.toString();
            return new URL(value, base).toString();
        } catch (_error) {
            return null;
        }
    }

    /**
     * Converts an original target URL into a proxy-wrapped URL.
     * Bypasses fragments and special protocols (e.g., "mailto:")
     *
     * e.g., "https://example.com/path?foo=bar" is converted into
     * "/<proxyPrefix>/https/example.com/path?foo=bar".
     */
    function toProxyUrl(input, base) {
        const absolute = toTargetUrl(input, base);
        if (
            !absolute ||
            absolute.startsWith("#") ||
            isSpecialProtocol(absolute)
        )
            return absolute;
        const parsed = new URL(absolute);
        const path =
            parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
        return `${proxyPrefix}/${parsed.protocol.slice(0, -1)}/${parsed.host}${path}${parsed.search}`;
    }

    return {
        isSpecialProtocol,
        inferTargetUrl,
        toTargetUrl,
        toProxyUrl,
    };
}

function getFullXPath(element) {
    if (!(element instanceof Element)) return "";
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
            if (sibling.tagName === current.tagName) index += 1;
            sibling = sibling.previousElementSibling;
        }
        parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
        current = current.parentElement;
    }
    return `/${parts.join("/")}`;
}

function textAnchor(element) {
    const raw = (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
    return raw.slice(0, 140);
}

/**
 * describeElement returns a stable descriptor for an element, shared by the
 * selection payload and recorded element events.
 */
function describeElement(element) {
    const rect = element.getBoundingClientRect();
    const tagName = element.tagName.toLowerCase();
    const xpath = getFullXPath(element);
    return {
        tagName,
        label: textAnchor(element) || tagName,
        textAnchor: textAnchor(element),
        full_xpath: xpath,
        bounds: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        },
    };
}

/**
 * resolveXPath returns the first element matching an absolute XPath, or null.
 * Used during initialstate replay to map recorded events back onto live DOM.
 */
function resolveXPath(xpath) {
    if (!xpath) return null;
    try {
        const result = document.evaluate(
            xpath,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null,
        );
        return result.singleNodeValue instanceof Element ?
                result.singleNodeValue
            :   null;
    } catch (_error) {
        return null;
    }
}

// Browser runtime — runs only in browser context
if (typeof window !== "undefined") {
    (() => {
        if (window.__vmPreviewInitialized) return;
        window.__vmPreviewInitialized = true;

        const PREVIEW_SELECTION_TYPE = __SELECTION_TYPE__;
        const PREVIEW_READY_TYPE = __READY_TYPE__;
        const PREVIEW_SET_MODE_TYPE = __SET_MODE_TYPE__;
        const PREVIEW_SET_SCALE_TYPE = __SET_SCALE_TYPE__;
        const PREVIEW_MODE_CHANGED_TYPE = __MODE_CHANGED_TYPE__;
        const PREVIEW_RECORD_EVENT_TYPE = __RECORD_EVENT_TYPE__;
        const PREVIEW_SET_INITIAL_STATE_TYPE = __SET_INITIAL_STATE_TYPE__;
        const PREVIEW_REPLAY_DONE_TYPE = __REPLAY_DONE_TYPE__;
        const RECORD_SESSION = __RECORD__;

        const { isSpecialProtocol, inferTargetUrl, toTargetUrl, toProxyUrl } =
            makeUrlUtils({
                proxyPrefix: __PROXY_PREFIX__,
                getOrigin: () => window.location.origin,
            });

        let currentTargetUrl =
            inferTargetUrl(window.location.href) || new URL(__CURRENT_TARGET__);

        let mode = RECORD_SESSION ? "recording" : "none";
        let currentElement = null;
        // While true the event dispatcher is suppressed and recorder.emit is a
        // no-op — set during initialstate replay and recording-session boot.
        let replaying = RECORD_SESSION;
        const originalCursor = document.documentElement.style.cursor || "";

        function postToParent(type, payload) {
            window.parent.postMessage({ type, payload }, "*");
        }

        function rewriteElementAttributes(element) {
            if (!(element instanceof Element)) return;

            for (const attr of ["src", "href", "poster", "action"]) {
                const value = element.getAttribute(attr);
                if (!value) continue;
                const proxied = toProxyUrl(value, currentTargetUrl.href);
                if (proxied && proxied !== value)
                    element.setAttribute(attr, proxied);
            }

            const srcset = element.getAttribute("srcset");
            if (srcset) {
                const rewritten = srcset
                    .split(",")
                    .map(candidate => {
                        const trimmed = candidate.trim();
                        if (!trimmed) return "";
                        const [url, ...rest] = trimmed.split(/\s+/);
                        const proxied =
                            toProxyUrl(url, currentTargetUrl.href) || url;
                        return rest.length ?
                                `${proxied} ${rest.join(" ")}`
                            :   proxied;
                    })
                    .join(", ");
                if (rewritten !== srcset)
                    element.setAttribute("srcset", rewritten);
            }

            if (element.hasAttribute("integrity"))
                element.removeAttribute("integrity");
            if (element.hasAttribute("crossorigin"))
                element.removeAttribute("crossorigin");
        }

        function rewriteTree(root) {
            if (!(root instanceof Element)) return;
            rewriteElementAttributes(root);
            if (root.querySelectorAll)
                root.querySelectorAll(
                    "[src],[href],[poster],[action],[srcset],[integrity],[crossorigin]",
                ).forEach(rewriteElementAttributes);
        }

        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
            const normalized = toTargetUrl(input, currentTargetUrl.href);
            if (
                !normalized ||
                normalized.startsWith("#") ||
                isSpecialProtocol(normalized)
            )
                return originalFetch(input, init);
            const proxied = toProxyUrl(normalized, currentTargetUrl.href);
            if (typeof input === "string") return originalFetch(proxied, init);
            const derivedInit = {
                method: input.method,
                headers: input.headers,
                body: input.body,
                cache: input.cache,
                credentials: input.credentials,
                integrity: input.integrity,
                keepalive: input.keepalive,
                mode: input.mode,
                redirect: input.redirect,
                referrer: input.referrer,
                referrerPolicy: input.referrerPolicy,
                signal: input.signal,
            };
            return originalFetch(new Request(proxied, derivedInit), init);
        };

        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            const normalized = toTargetUrl(url, currentTargetUrl.href);
            const nextUrl =
                (
                    normalized &&
                    !normalized.startsWith("#") &&
                    !isSpecialProtocol(normalized)
                ) ?
                    toProxyUrl(normalized, currentTargetUrl.href)
                :   url;
            return originalOpen.call(this, method, nextUrl, ...rest);
        };

        function patchHistoryMethod(originalMethod) {
            return (state, unused, url) => {
                if (url) {
                    const normalized = toTargetUrl(url, currentTargetUrl.href);
                    if (
                        normalized &&
                        !normalized.startsWith("#") &&
                        !isSpecialProtocol(normalized)
                    ) {
                        currentTargetUrl = new URL(normalized);
                        recorder.emit({ type: "navigation" });
                        return originalMethod(
                            state,
                            unused,
                            toProxyUrl(normalized, currentTargetUrl.href),
                        );
                    }
                }
                return originalMethod(state, unused, url);
            };
        }

        const originalPushState = history.pushState.bind(history);
        history.pushState = patchHistoryMethod(originalPushState);

        const originalReplaceState = history.replaceState.bind(history);
        history.replaceState = patchHistoryMethod(originalReplaceState);

        window.addEventListener("popstate", () => {
            const inferred = inferTargetUrl(window.location.href);
            if (inferred) {
                currentTargetUrl = inferred;
                recorder.emit({ type: "navigation" });
            }
        });

        const originalOpenWindow = window.open.bind(window);
        window.open = (url, target, features) => {
            const normalized = toTargetUrl(url, currentTargetUrl.href);
            if (
                normalized &&
                !normalized.startsWith("#") &&
                !isSpecialProtocol(normalized)
            ) {
                return originalOpenWindow(
                    toProxyUrl(normalized, currentTargetUrl.href),
                    target,
                    features,
                );
            }
            return originalOpenWindow(url, target, features);
        };

        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                if (
                    mutation.type === "attributes" &&
                    mutation.target instanceof Element
                ) {
                    rewriteElementAttributes(mutation.target);
                }
                if (mutation.type === "childList") {
                    mutation.addedNodes.forEach(node => {
                        if (node instanceof Element) rewriteTree(node);
                    });
                }
            }
        });

        if (document.documentElement) {
            observer.observe(document.documentElement, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: [
                    "src",
                    "href",
                    "poster",
                    "action",
                    "srcset",
                    "integrity",
                    "crossorigin",
                ],
            });
            rewriteTree(document.documentElement);
        }

        // --- Shared UI services ---

        const overlay = document.createElement("div");
        overlay.id = "__vm_picker_overlay";
        overlay.innerHTML =
            '<div id="__vm_picker_box"><div id="__vm_picker_badge"></div></div>';
        document.documentElement.appendChild(overlay);

        const status = document.createElement("div");
        status.id = "__vm_picker_status";
        document.documentElement.appendChild(status);

        const box = overlay.querySelector("#__vm_picker_box");
        const overlayBadge = overlay.querySelector("#__vm_picker_badge");

        const ui = {
            badge: {
                set(text) {
                    status.textContent = text;
                    status.style.display = "block";
                },
                hide() {
                    status.style.display = "none";
                },
            },
            overlay: {
                update(element) {
                    if (!(element instanceof Element) || !box || !overlayBadge)
                        return;
                    const rect = element.getBoundingClientRect();
                    currentElement = element;
                    box.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
                    box.style.width = `${Math.max(rect.width, 0)}px`;
                    box.style.height = `${Math.max(rect.height, 0)}px`;
                    overlayBadge.textContent = element.tagName.toLowerCase();
                    // At the top of the page a label above the box would be
                    // cut off: it goes inside the box's top-left corner.
                    const unit = Number(
                        getComputedStyle(overlay).getPropertyValue("--vm-ui") ||
                            1,
                    );
                    overlayBadge.classList.toggle(
                        "__vm_inside",
                        rect.top < 16 * unit,
                    );
                },
                show() {
                    overlay.style.display = "block";
                },
                hide() {
                    overlay.style.display = "none";
                    currentElement = null;
                },
            },
        };

        function isOwnUI(element) {
            return (
                element.id === "__vm_picker_overlay" ||
                element.closest("#__vm_picker_status")
            );
        }

        // --- Recorder service ---

        const recorder = {
            // Baseline captured once so `t` stays continuous across
            // selection <-> recording toggles within a session.
            start: Date.now(),
            emit(partial) {
                if (replaying || mode !== "recording") return;
                postToParent(PREVIEW_RECORD_EVENT_TYPE, {
                    t: Date.now() - this.start,
                    pageUrl: currentTargetUrl.toString(),
                    ...partial,
                });
            },
            // Fast-forward best-effort replay of a seed timeline. Only events
            // recorded on the current page are applied; cross-navigation replay
            // is driven by the host app, not here.
            replay(events) {
                replaying = true;
                ui.badge.set("Preparing…");
                const here = currentTargetUrl.toString();
                for (const ev of Array.isArray(events) ? events : []) {
                    if (ev.pageUrl && ev.pageUrl !== here) continue;
                    applyReplayEvent(ev);
                }
                replaying = false;
                postToParent(PREVIEW_REPLAY_DONE_TYPE, { pageUrl: here });
                // Re-assert the active mode now that control is handed back.
                setMode(mode);
            },
        };

        function applyReplayEvent(ev) {
            try {
                if (ev.type === "scroll") {
                    window.scrollTo(ev.scrollX || 0, ev.scrollY || 0);
                    return;
                }
                const element = resolveXPath(ev.xpath || ev.full_xpath);
                if (!element) return;
                switch (ev.type) {
                    case "click":
                        element.click();
                        break;
                    case "input":
                    case "change":
                        if ("value" in element) element.value = ev.value ?? "";
                        element.dispatchEvent(
                            new Event(ev.type, { bubbles: true }),
                        );
                        break;
                    case "keydown":
                        element.dispatchEvent(
                            new KeyboardEvent("keydown", {
                                key: ev.key,
                                code: ev.code,
                                bubbles: true,
                            }),
                        );
                        break;
                }
            } catch (_error) {
                /* best-effort: skip events that no longer resolve */
            }
        }

        // --- Mode registry -------------------------------------------------

        function targetElement(event) {
            const element =
                event.target instanceof Element ? event.target : null;
            if (!element || isOwnUI(element)) return null;
            return element;
        }

        const modes = {
            none: { badge: null, handlers: {} },
            navigation: { badge: "Navigation mode", handlers: {} },
            selection: {
                badge: "Selection mode",
                onEnter() {
                    ui.overlay.show();
                    document.documentElement.style.cursor = "crosshair";
                },
                onExit() {
                    ui.overlay.hide();
                    document.documentElement.style.cursor = originalCursor;
                },
                handlers: {
                    mousemove(event) {
                        const element = targetElement(event);
                        if (element) ui.overlay.update(element);
                    },
                    click(event) {
                        const element = targetElement(event);
                        if (!element) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.stopImmediatePropagation();
                        ui.overlay.update(element);
                        postToParent(PREVIEW_SELECTION_TYPE, {
                            pageUrl: currentTargetUrl.toString(),
                            ...describeElement(element),
                        });
                    },
                },
            },
            recording: {
                badge: "Recording",
                handlers: {
                    click(event) {
                        const element = targetElement(event);
                        if (element)
                            recorder.emit({
                                type: "click",
                                ...describeElement(element),
                            });
                    },
                    input(event) {
                        const element = targetElement(event);
                        if (element)
                            recorder.emit({
                                type: "input",
                                value: element.value ?? "",
                                ...describeElement(element),
                            });
                    },
                    change(event) {
                        const element = targetElement(event);
                        if (element)
                            recorder.emit({
                                type: "change",
                                value: element.value ?? "",
                                ...describeElement(element),
                            });
                    },
                    submit(event) {
                        const element = targetElement(event);
                        if (element)
                            recorder.emit({
                                type: "submit",
                                ...describeElement(element),
                            });
                    },
                    keydown(event) {
                        const element = targetElement(event);
                        recorder.emit({
                            type: "keydown",
                            key: event.key,
                            code: event.code,
                            modifiers: {
                                alt: event.altKey,
                                ctrl: event.ctrlKey,
                                meta: event.metaKey,
                                shift: event.shiftKey,
                            },
                            ...(element ? describeElement(element) : {}),
                        });
                    },
                    scroll() {
                        recorder.emit({
                            type: "scroll",
                            scrollX: window.scrollX,
                            scrollY: window.scrollY,
                        });
                    },
                },
            },
        };

        // --- Mode controller ----------------------------------------------

        function announceMode() {
            postToParent(PREVIEW_MODE_CHANGED_TYPE, {
                mode,
                pageUrl: currentTargetUrl.toString(),
            });
        }

        function setMode(nextMode) {
            let next = modes[nextMode] ? nextMode : "none";
            // Recording sessions are locked to recording <-> selection.
            if (RECORD_SESSION && next !== "recording" && next !== "selection")
                next = "recording";

            if (modes[mode]?.onExit) modes[mode].onExit();
            mode = next;
            const active = modes[mode];
            if (active.onEnter) active.onEnter();
            if (active.badge && !replaying) ui.badge.set(active.badge);
            else if (!replaying) ui.badge.hide();
            announceMode();
        }

        // --- Event dispatcher (the extension point) ------------------------

        const DISPATCHED_EVENTS = [
            "mousemove",
            "click",
            "input",
            "change",
            "submit",
            "keydown",
            "scroll",
        ];
        for (const type of DISPATCHED_EVENTS) {
            const listen = type === "scroll" ? window : document;
            listen.addEventListener(
                type,
                event => {
                    if (replaying) return;
                    const handler = modes[mode]?.handlers?.[type];
                    if (handler) handler(event);
                },
                true,
            );
        }

        function refreshOverlay() {
            if (mode === "selection" && currentElement)
                ui.overlay.update(currentElement);
        }
        window.addEventListener("scroll", refreshOverlay, true);
        window.addEventListener("resize", refreshOverlay);

        // --- Parent message channel ---------------------------------------

        window.addEventListener("message", event => {
            if (!event.data || typeof event.data !== "object") return;
            if (event.data.type === PREVIEW_SET_MODE_TYPE) {
                setMode(event.data.payload?.mode);
            } else if (event.data.type === PREVIEW_SET_SCALE_TYPE) {
                // The parent shows this page scaled; the overlay is drawn
                // 1/scale as large so it keeps its size on screen.
                const scale = Number(event.data.payload?.scale);
                if (scale > 0 && Number.isFinite(scale)) {
                    overlay.style.setProperty("--vm-ui", String(1 / scale));
                    refreshOverlay();
                }
            } else if (
                event.data.type === PREVIEW_SET_INITIAL_STATE_TYPE &&
                RECORD_SESSION
            ) {
                if (initialStateTimer) clearTimeout(initialStateTimer);
                recorder.replay(event.data.payload?.events);
            }
        });

        // --- Boot ----------------------------------------------------------

        let initialStateTimer = null;
        if (RECORD_SESSION) {
            // Control stays blocked (replaying=true) until the parent seeds the
            // timeline via set-initial-state; release after a fallback so the
            // page never freezes if nothing is sent.
            ui.badge.set("Preparing…");
            initialStateTimer = setTimeout(() => {
                if (replaying) recorder.replay([]);
            }, 1500);
        } else {
            setMode("none");
        }

        postToParent(PREVIEW_READY_TYPE, {
            pageUrl: currentTargetUrl.toString(),
        });
    })();
}

// CJS exports for unit testing (no-op in browser)
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        makeUrlUtils,
        getFullXPath,
        textAnchor,
    };
}
