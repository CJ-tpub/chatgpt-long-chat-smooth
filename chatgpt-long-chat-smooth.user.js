// ==UserScript==
// @name         ChatGPT 网页长对话交互卡顿优化
// @name:en      ChatGPT Web Long Chat Interaction Optimizer
// @namespace    https://github.com/CJ-tpub/chatgpt-long-chat-smooth
// @version      0.6.7
// @description  优化 ChatGPT 网页长对话/长会话的输入、点击和滚动交互，减少卡顿，让操作更顺滑。
// @description:en Optimize typing, clicking and scrolling interactions in long ChatGPT web conversations by reducing lag.
// @homepageURL  https://github.com/CJ-tpub/chatgpt-long-chat-smooth
// @supportURL   https://github.com/CJ-tpub/chatgpt-long-chat-smooth/issues
// @downloadURL  https://raw.githubusercontent.com/CJ-tpub/chatgpt-long-chat-smooth/main/chatgpt-long-chat-smooth.user.js
// @updateURL    https://raw.githubusercontent.com/CJ-tpub/chatgpt-long-chat-smooth/main/chatgpt-long-chat-smooth.user.js
// @license      PolyForm-Noncommercial-1.0.0
// @match        https://chatgpt.com/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

// @ts-check
'use strict';

{
    const topWindow = window.top === window.self;
    const instanceKey = '__cgptLongChatLiteInstance';
    if (topWindow && !Object.prototype.hasOwnProperty.call(window, instanceKey)) {
        // 防止重复加载时叠加多个全局观察器代理和状态集合。
        Object.defineProperty(window, instanceKey, {configurable: false, value: true});
        const version = '0.6.7';
        const panelId = 'cgpt-long-chat-lite-panel';
        const noticeId = 'cgpt-long-chat-lite-notice';
        const feedbackHostId = 'cgpt-long-chat-lite-feedback';
        const feedbackStorageKey = 'cgpt-lcl:v1:feedback';
        const feedbackLinks = {
            greasyfork: 'https://greasyfork.org/zh-CN/scripts/601032/feedback',
            github: 'https://github.com/CJ-tpub/chatgpt-long-chat-smooth/issues'
        };
        // 提示层规则：安装满 3 个自然日、累计可见使用 30 分钟、打开过 3 次页面；
        // 未勾选「不再弹出」时 30 天后才允许再提示一次。
        const feedbackRules = {
            minDays: 3,
            minActiveMs: 30 * 60 * 1000,
            minOpens: 3,
            cooldownMs: 30 * 24 * 60 * 60 * 1000,
            tickMs: 30000,
            persistMs: 5 * 60 * 1000,
            checkDelayMs: 8000,
            duplicateWindowMs: 10000
        };
        const testUiEnabled = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
        const testDisplayQuery = new URLSearchParams(location.search);
        const testDisplayDisabled = testUiEnabled && testDisplayQuery.has('cgpt-lcl-no-display');
        const testDisplayEnabled = testUiEnabled && testDisplayQuery.has('display-test');
        const feedbackTestEnabled = testUiEnabled && testDisplayQuery.has('feedback-test');
        const feedbackForceTest = feedbackTestEnabled && testDisplayQuery.has('feedback-force');
        const marker = 'cgpt-long-chat-lite-history';
        const heightProperty = '--cgpt-long-chat-lite-height';
        const messageSelector = '[data-chatgpt-search-unit-key], [data-testid^="conversation-turn-"]';
        const recentCount = 4;
        const layerStorageKey = 'cgpt-lcl:v3:layers';

        /** @typedef {{damper: boolean, composer: boolean, contentVisibility: boolean, display: boolean}} LayerState */
        /** @type {LayerState} */
        const layers = readLayerState();
        let totalEnabled = true;
        let recording = false;
        let reportText = '';
        let reportEnabled = false;
        let reportFocusEnabled = false;
        let reportLayers = {damper: false, composer: false, contentVisibility: false};

        // 在页面脚本初始化前捕获原生构造器；L1 关闭时恢复。
        const NativeMutationObserver = window.MutationObserver;
        const NativeResizeObserver = window.ResizeObserver;
        const NativeSetAttribute = Element.prototype.setAttribute;
        const NativeSetAttributeNS = Element.prototype.setAttributeNS;
        /** @type {Set<any>} */
        const observerStates = new Set();
        let damperInstalled = false;
        let attributeGuardInstalled = false;
        let attributeWritesSkipped = 0;

        // 只拦截已知会被页面重复写成同值的热属性；同值写入没有语义变化，却会触发整棵子树重算。
        function installAttributeGuard() {
            if (attributeGuardInstalled) return;
            attributeGuardInstalled = true;
            /** @this {Element} @param {string} name @param {string} value */
            Element.prototype.setAttribute = function (name, value) {
                if (name === 'data-dil-message-id' && this.getAttribute(name) === String(value)) {
                    attributeWritesSkipped += 1;
                    return;
                }
                return NativeSetAttribute.call(this, name, value);
            };
            /** @this {Element} @param {string | null} namespace @param {string} name @param {string} value */
            Element.prototype.setAttributeNS = function (namespace, name, value) {
                if (name === 'data-dil-message-id' && this.getAttribute(name) === String(value)) {
                    attributeWritesSkipped += 1;
                    return;
                }
                return NativeSetAttributeNS.call(this, namespace, name, value);
            };
        }

        function restoreAttributeGuard() {
            if (!attributeGuardInstalled) return;
            Element.prototype.setAttribute = NativeSetAttribute;
            Element.prototype.setAttributeNS = NativeSetAttributeNS;
            attributeGuardInstalled = false;
        }
        const damperStats = {
            moCalls: 0,
            moConstructs: 0,
            moBypassedConstructs: 0,
            moCoalesced: 0,
            moMaxPerSecond: 0,
            roCalls: 0,
            roConstructs: 0,
            roBypassedConstructs: 0,
            roCoalesced: 0,
            roMaxPerSecond: 0,
            /** @type {Map<string, number>} */
            targets: new Map()
        };

        /** @returns {LayerState} */
        function readLayerState() {
            // 0.4.0 极简版没有用户开关；忽略旧版 sessionStorage，避免升级后沿用“关闭”状态。
            return {damper: true, composer: false, contentVisibility: true, display: true};
        }

        function saveLayerState() {
            try { sessionStorage.setItem(layerStorageKey, JSON.stringify(layers)); } catch { /* 存储不可用时忽略。 */ }
        }

        /** @param {Element | null | undefined} element */
        function describeTarget(element) {
            if (!(element instanceof Element)) return 'non-element';
            return element.tagName.toLowerCase();
        }

        /** @param {EventTarget | null} target @param {MutationObserverInit | undefined} options */
        function isDocumentWideTarget(target, options) {
            if (!(target instanceof Node)) return false;
            const element = target instanceof Element ? target : target.parentElement;
            if (!element) return false;
            const main = document.querySelector('main');
            if (element === document.documentElement || element === document.body || (main !== null && element === main)) {
                return true;
            }
            return options?.subtree === true
                && (element === document.documentElement || element === document.body);
        }

        /** @param {any} state @param {MutationRecord[]} records */
        function deliverMutation(state, records) {
            try {
                state.original(records, state.observer);
            } catch (error) {
                window.setTimeout(() => { throw error; }, 0);
            }
        }

        /** @param {any} state */
        function flushMutation(state) {
            if (state.timer) {
                window.clearTimeout(state.timer);
                state.timer = 0;
            }
            if (!state.pending.length) return;
            const pending = state.pending;
            state.pending = [];
            deliverMutation(state, pending);
        }

        function installDamper() {
            if (damperInstalled || typeof NativeMutationObserver !== 'function') return;
            damperInstalled = true;

            // 使用 Proxy 保留 instanceof 语义；被包装的观察器仍返回原生实例。
            window.MutationObserver = /** @type {any} */ (new Proxy(NativeMutationObserver, {
                construct(target, args) {
                    const original = args[0];
                    if (typeof original !== 'function' || !layers.damper) {
                        damperStats.moBypassedConstructs += 1;
                        return Reflect.construct(target, args);
                    }
                    damperStats.moConstructs += 1;
                    /** @type {any} */
                    const state = {
                        original,
                        observer: null,
                        wide: false,
                        windowStart: performance.now(),
                        calls: 0,
                        pending: [],
                        timer: 0,
                        passthrough: false
                    };
                    const observer = new target((records) => {
                        damperStats.moCalls += 1;
                        const now = performance.now();
                        if (now - state.windowStart >= 1000) {
                            state.windowStart = now;
                            state.calls = 0;
                        }
                        state.calls += 1;
                        damperStats.moMaxPerSecond = Math.max(damperStats.moMaxPerSecond, state.calls);
                        const storm = state.wide || state.calls > 20;
                        if (!layers.damper || state.passthrough || !storm) {
                            deliverMutation(state, records);
                            return;
                        }
                        for (const record of records) state.pending.push(record);
                        const limit = 10000;
                        if (state.pending.length > limit) state.pending.splice(0, state.pending.length - limit);
                        if (state.timer) return;
                        state.timer = window.setTimeout(() => {
                            state.timer = 0;
                            if (!state.pending.length) return;
                            const pending = state.pending;
                            state.pending = [];
                            damperStats.moCoalesced += 1;
                            deliverMutation(state, pending);
                        }, 100);
                    });
                    state.observer = observer;
                    const nativeObserve = observer.observe.bind(observer);
                    observer.observe = (node, options) => {
                        state.wide = isDocumentWideTarget(node, options);
                        const key = describeTarget(node instanceof Element ? node : null);
                        if (state.wide) damperStats.targets.set(key, (damperStats.targets.get(key) ?? 0) + 1);
                        const result = nativeObserve(node, options);
                        // 只有真正开始观察时才保留状态；同一个观察器重新 observe 时重新登记。
                        observerStates.add(state);
                        return result;
                    };
                    const nativeDisconnect = observer.disconnect.bind(observer);
                    observer.disconnect = () => {
                        if (state.timer) {
                            window.clearTimeout(state.timer);
                            state.timer = 0;
                        }
                        state.pending.length = 0;
                        observerStates.delete(state);
                        return nativeDisconnect();
                    };
                    return observer;
                }
            }));

            if (typeof NativeResizeObserver === 'function') {
                window.ResizeObserver = /** @type {any} */ (new Proxy(NativeResizeObserver, {
                    construct(target, args) {
                        const original = args[0];
                        if (typeof original !== 'function' || !layers.damper) {
                            damperStats.roBypassedConstructs += 1;
                            return Reflect.construct(target, args);
                        }
                        damperStats.roConstructs += 1;
                        /** @type {any} */
                        const state = {
                            original,
                            observer: null,
                            windowStart: performance.now(),
                            calls: 0,
                            pending: new Map(),
                            observedTargets: new Set(),
                            timer: 0,
                            passthrough: false
                        };
                        const observer = new target((entries) => {
                            damperStats.roCalls += 1;
                            const now = performance.now();
                            if (now - state.windowStart >= 1000) {
                                state.windowStart = now;
                                state.calls = 0;
                            }
                            state.calls += 1;
                            damperStats.roMaxPerSecond = Math.max(damperStats.roMaxPerSecond, state.calls);
                            const storm = state.calls > 30;
                            if (!layers.damper || state.passthrough || !storm) {
                                try { original(entries, observer); } catch (error) { window.setTimeout(() => { throw error; }, 0); }
                                return;
                            }
                            for (const entry of entries) state.pending.set(entry.target, entry);
                            if (state.timer) return;
                            state.timer = window.setTimeout(() => {
                                state.timer = 0;
                                if (!state.pending.size) return;
                                const pending = Array.from(state.pending.values());
                                state.pending.clear();
                                damperStats.roCoalesced += 1;
                                try { original(pending, observer); } catch (error) { window.setTimeout(() => { throw error; }, 0); }
                            }, 80);
                        });
                        state.observer = observer;
                        const nativeObserve = observer.observe.bind(observer);
                        observer.observe = (node, options) => {
                            const result = nativeObserve(node, options);
                            state.observedTargets.add(node);
                            observerStates.add(state);
                            return result;
                        };
                        const nativeUnobserve = observer.unobserve.bind(observer);
                        observer.unobserve = (node) => {
                            const result = nativeUnobserve(node);
                            state.observedTargets.delete(node);
                            if (!state.observedTargets.size) observerStates.delete(state);
                            return result;
                        };
                        const nativeDisconnect = observer.disconnect.bind(observer);
                        observer.disconnect = () => {
                            if (state.timer) {
                                window.clearTimeout(state.timer);
                                state.timer = 0;
                            }
                            state.pending.clear();
                            state.observedTargets.clear();
                            observerStates.delete(state);
                            return nativeDisconnect();
                        };
                        return observer;
                    }
                }));
            }
        }

        /** @param {boolean} enabled @param {boolean} persist */
        function setDamper(enabled, persist = true) {
            if (persist) {
                layers.damper = enabled;
                saveLayerState();
            }
            const active = enabled && totalEnabled;
            if (active) installAttributeGuard(); else restoreAttributeGuard();
            if (active) installDamper();
            for (const state of observerStates) {
                state.passthrough = !active;
                if (!active) {
                    if (state.pending instanceof Map) {
                        if (state.pending.size) {
                            const pending = Array.from(state.pending.values());
                            state.pending.clear();
                            try { state.original(pending, state.observer); } catch (error) { window.setTimeout(() => { throw error; }, 0); }
                        }
                    } else if (state.pending?.length) {
                        flushMutation(state);
                    }
                }
            }
            if (!active) {
                window.MutationObserver = NativeMutationObserver;
                if (typeof NativeResizeObserver === 'function') window.ResizeObserver = NativeResizeObserver;
                damperInstalled = false;
            } else {
                installDamper();
            }
            updateUi();
        }

        // 页面尚未初始化时先安装 L1；UI 在 body 可用后创建。
        if (layers.damper) {
            installDamper();
            installAttributeGuard();
        }

        /** @type {Map<HTMLElement, {value: string, priority: string, hadStyle: boolean, hadClass: boolean}>} */
        const marked = new Map();
        let contentVisibilityEnabled = false;
        let syncTimer = 0;
        let messageCount = 0;
        let focusEnabled = false;
        let uiStarted = false;
        let faultNoticeShown = false;
        /** @type {MutationObserver | null} */
        let contentObserver = null;
        const dummyPanel = document.createElement('div');
        let panel = document.createElement('div');
        let shadow = dummyPanel.attachShadow({mode: 'open'});
        let status = document.createElement('p');
        let layerStatus = document.createElement('p');
        let summary = document.createElement('summary');
        let section = document.createElement('section');
        let toggleButton = document.createElement('button');
        let diagnoseButton = document.createElement('button');
        let downloadButton = document.createElement('button');
        let focusButton = document.createElement('button');
        let focusDescription = document.createElement('p');
        let damperButton = document.createElement('button');
        let contentButton = document.createElement('button');
        let copyButton = document.createElement('button');
        let displayButton = document.createElement('button');
        let diagnosticStatus = document.createElement('p');

        /** @returns {HTMLElement[]} */
        const findTurns = () => {
            const main = document.querySelector('main');
            if (!main) return [];
            return /** @type {HTMLElement[]} */ (Array.from(main.querySelectorAll(messageSelector))
                .filter((element) => element instanceof HTMLElement
                    && !element.parentElement?.closest(messageSelector)
                    && !element.closest('[data-lcl-twin]')
                    && element.dataset.lclParked !== '1'));
        };

        /** @param {Element} element @returns {Element | null} */
        const findScrollRoot = (element) => {
            let node = element.parentElement;
            while (node && node !== document.body && node !== document.documentElement) {
                const style = getComputedStyle(node);
                if (/(auto|scroll)/.test(style.overflowY)) return node;
                node = node.parentElement;
            }
            return document.scrollingElement;
        };

        /** @returns {{turnCount: number, elementCount: number | null, topTurnElementCounts: number[], scrollHeight: number | null, scrollTop: number | null}} */
        const getThreadStats = () => {
            const main = document.querySelector('main');
            const turns = findTurns();
            const scrollRoot = turns[0] ? findScrollRoot(turns[0]) : null;
            return {
                turnCount: turns.length,
                elementCount: main ? main.querySelectorAll('*').length : null,
                topTurnElementCounts: turns.map((turn) => turn.querySelectorAll('*').length)
                    .sort((a, b) => b - a).slice(0, 5),
                scrollHeight: scrollRoot && scrollRoot instanceof Element ? scrollRoot.scrollHeight : null,
                scrollTop: scrollRoot && scrollRoot instanceof Element ? scrollRoot.scrollTop : null
            };
        };

        /** @param {string} message */
        const showFaultNotice = (message) => {
            if (faultNoticeShown) return;
            faultNoticeShown = true;
            const host = document.createElement('div');
            host.id = noticeId;
            const shadow = host.attachShadow({mode: 'open'});
            const style = document.createElement('style');
            style.textContent = ':host { position:fixed; right:14px; bottom:14px; z-index:2147483000;'
                + ' color-scheme:light dark; font:12px/1.5 system-ui,sans-serif; }\n'
                + '.box { max-width:300px; display:flex; align-items:flex-start; gap:8px; padding:10px 12px;'
                + ' border:1px solid #f0a000; border-radius:8px; background:Canvas; color:CanvasText;'
                + ' box-shadow:0 2px 12px #0002; }\n'
                + 'span { flex:1; }\n'
                + 'button { font:inherit; padding:2px 6px; cursor:pointer; }\n'
                + '@media print { :host { display:none; } }';
            const box = document.createElement('div');
            box.className = 'box';
            const text = document.createElement('span');
            text.textContent = message;
            const close = document.createElement('button');
            close.type = 'button';
            close.textContent = '关闭';
            close.addEventListener('click', () => host.remove());
            box.append(text, close);
            shadow.append(style, box);
            (document.body || document.documentElement).append(host);
            window.setTimeout(() => host.remove(), 12000);
        };

        const getDamperSnapshot = () => ({
            installed: damperInstalled,
            damperEnabled: layers.damper,
            mutationObserverWrapped: window.MutationObserver !== NativeMutationObserver,
            resizeObserverWrapped: typeof NativeResizeObserver === 'function'
                && window.ResizeObserver !== NativeResizeObserver,
            moCalls: damperStats.moCalls,
            moConstructs: damperStats.moConstructs,
            moBypassedConstructs: damperStats.moBypassedConstructs,
            moCoalesced: damperStats.moCoalesced,
            moMaxPerSecond: damperStats.moMaxPerSecond,
            roCalls: damperStats.roCalls,
            roConstructs: damperStats.roConstructs,
            roBypassedConstructs: damperStats.roBypassedConstructs,
            roCoalesced: damperStats.roCoalesced,
            roMaxPerSecond: damperStats.roMaxPerSecond,
            attributeWritesSkipped,
            activeObserverStates: observerStates.size,
            topTargets: Array.from(damperStats.targets.entries())
                .sort((a, b) => b[1] - a[1]).slice(0, 10)
                .map(([target, count]) => ({target, count}))
        });

        // 仅为本地回归提供只读快照；真实 ChatGPT 页面不暴露调试入口。
        if (testUiEnabled) {
            if (!Object.prototype.hasOwnProperty.call(window, '__cgptLongChatLiteTest')) {
                Object.defineProperty(window, '__cgptLongChatLiteTest', {
                    configurable: true,
                    value: {getDamperSnapshot, showFaultNotice,
                        getFeedbackSnapshot: () => ({
                            enabled: feedbackEnabled(),
                            state: feedbackState
                                ? {...feedbackState, days: [...feedbackState.days]}
                                : null,
                            host: Boolean(document.getElementById(feedbackHostId)),
                            forced: feedbackForceTest,
                            dismissed: feedbackDismissed
                        }),
                        showFeedback: () => showFeedbackDialog(),
                        dismissFeedback: () => dismissFeedback(),
                        getDisplaySnapshot: () => ({
                        enabled: displayEnabled,
                        attempts: displayActivationAttempts,
                        error: displayActivationError,
                        twin: Boolean(document.querySelector('[data-lcl-twin]')),
                        activeObserverStates: observerStates.size,
                        healthMisses: displayHealthMisses,
                        observedMainConnected: Boolean(displayObservedMain?.isConnected),
                        displayObserverAttached: Boolean(displayObserver),
                        counters: {...displayCounters}
                    }), maintainParking: () => maintainParking()}
                });
            }
        }

        const updateUi = () => {
            if (!testUiEnabled) return;
            if (!summary || !toggleButton || !damperButton || !contentButton || !layerStatus) return;
            summary.textContent = focusEnabled ? '输入优先：回答已收起'
                : '长对话优化：' + (totalEnabled ? '开' : '关');
            toggleButton.textContent = totalEnabled ? '关闭优化并恢复原状' : '启用优化';
            toggleButton.setAttribute('aria-pressed', String(totalEnabled));
            damperButton.textContent = '观察器抑制：' + (layers.damper ? '开' : '关');
            damperButton.setAttribute('aria-pressed', String(layers.damper));
            contentButton.textContent = '历史消息轻量：' + (layers.contentVisibility ? '开' : '关');
            contentButton.setAttribute('aria-pressed', String(layers.contentVisibility));
            displayButton.textContent = '轻量显示：' + (layers.display ? '开' : '关');
            displayButton.setAttribute('aria-pressed', String(layers.display));
            const displayPart = displayEnabled
                ? '已收起 ' + parkedTurns.size + ' 条，最新回答' + (shieldState ? '已孪生' : '原样')
                    + '（收起 ' + displayCounters.park + ' / 恢复 ' + displayCounters.unpark
                    + ' / 孪生 ' + displayCounters.shield + '）'
                : '轻量显示未启用';
            layerStatus.textContent = '消息 ' + messageCount + ' 个，轻量 ' + marked.size + ' 个；观察器回调 '
                + damperStats.moCalls + '，合并 ' + damperStats.moCoalesced + '，跳过同值属性 '
                + attributeWritesSkipped + ' 次；' + displayPart + '。';
        };

        const removeMarkers = () => {
            for (const [element, original] of marked) {
                element.classList.remove(marker);
                if (original.value) element.style.setProperty(heightProperty, original.value, original.priority);
                else element.style.removeProperty(heightProperty);
                if (!original.hadClass && element.getAttribute('class') === '') element.removeAttribute('class');
                if (!original.hadStyle && element.getAttribute('style') === '') element.removeAttribute('style');
            }
            marked.clear();
        };

        // 批量读取新容器的高度，再统一写样式，避免交错读写引起反复排版。
        const synchronize = () => {
            syncTimer = 0;
            if (!totalEnabled || !layers.contentVisibility) return;
            const messages = findTurns();
            messageCount = messages.length;
            const historical = new Set(messages.slice(0, -recentCount));

            // 会话切换、消息删除或容器进入最近四条时，撤销此前的局部标记。
            for (const [element, original] of marked) {
                if (historical.has(element) && element.isConnected) continue;
                element.classList.remove(marker);
                if (original.value) element.style.setProperty(heightProperty, original.value, original.priority);
                else element.style.removeProperty(heightProperty);
                if (!original.hadClass && element.getAttribute('class') === '') element.removeAttribute('class');
                if (!original.hadStyle && element.getAttribute('style') === '') element.removeAttribute('style');
                marked.delete(element);
            }
            /** @type {Array<{element: HTMLElement, height: number}>} */
            const pending = [];
            for (const element of historical) {
                if (!(element instanceof HTMLElement) || marked.has(element)) continue;
                // 已有原生虚拟化或隐藏机制的容器交给网页处理，不强行展开或接管。
                if (element.closest('[data-virtualized-turn-content]')) continue;
                const computed = getComputedStyle(element);
                if (computed.contentVisibility === 'auto' || computed.contentVisibility === 'hidden') continue;
                const height = element.getBoundingClientRect().height
                    - (parseFloat(computed.paddingTop) || 0) - (parseFloat(computed.paddingBottom) || 0)
                    - (parseFloat(computed.borderTopWidth) || 0) - (parseFloat(computed.borderBottomWidth) || 0);
                if (height > 0) pending.push({element, height});
            }
            for (const {element, height} of pending) {
                marked.set(element, {value: element.style.getPropertyValue(heightProperty),
                    priority: element.style.getPropertyPriority(heightProperty),
                    hadStyle: element.hasAttribute('style'), hadClass: element.hasAttribute('class')});
                element.style.setProperty(heightProperty, height.toFixed(2) + 'px');
                element.classList.add(marker);
            }
            if (status) {
                status.textContent = messageCount === 0 ? '未识别消息结构，未修改消息。'
                    : '消息容器 ' + messageCount + ' 个，优化 ' + marked.size + ' 个；最近 ' + recentCount + ' 个保持原样。';
            }
            updateUi();
        };

        /** @param {boolean} nextEnabled @param {boolean} persist */
        const setContentVisibility = (nextEnabled, persist = true) => {
            if (recording) return;
            if (persist) {
                layers.contentVisibility = nextEnabled;
                saveLayerState();
            }
            const active = nextEnabled && totalEnabled;
            if (active) {
                if (!document.getElementById('cgpt-long-chat-lite-style')) document.head.append(renderStyle);
                if (!contentObserver) {
                    // 本项目自己的观察器使用原生构造器，避免被 L1 合并影响窗口移动。
                    contentObserver = new NativeMutationObserver((records) => {
                        if (!totalEnabled || !layers.contentVisibility || syncTimer) return;
                        const boundaryChanged = records.some((record) =>
                            [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element
                                && (node.matches(messageSelector) || node.querySelector(messageSelector))));
                        if (boundaryChanged) syncTimer = window.setTimeout(synchronize, 120);
                    });
                    contentObserver.observe(document.body, {childList: true, subtree: true});
                }
                contentVisibilityEnabled = true;
                syncTimer = window.setTimeout(synchronize, 120);
            } else {
                contentObserver?.disconnect();
                contentObserver = null;
                window.clearTimeout(syncTimer);
                syncTimer = 0;
                removeMarkers();
                renderStyle.remove();
                contentVisibilityEnabled = false;
                if (status) status.textContent = '已恢复原状；消息观察器已停止。';
            }
            updateUi();
        };

        /** @param {boolean} on @param {boolean} force */
        const setFocusEnabled = (on, force = false) => {
            if (recording && !force) return;
            focusEnabled = on;
            if (focusEnabled) document.head.append(focusStyle);
            else focusStyle.remove();
            if (focusButton) {
                focusButton.textContent = focusEnabled ? '恢复完整回答' : '输入优先：临时收起回答';
                focusButton.setAttribute('aria-pressed', String(focusEnabled));
            }
            if (focusDescription) {
                focusDescription.textContent = focusEnabled ? '回答已暂时收起；Ctrl+F 会先恢复全文。'
                    : '默认关闭；只在输入或操作菜单时临时收起回答。';
            }
            updateUi();
        };

        /** @param {boolean} on */
        const setTotalEnabled = (on) => {
            if (recording) return;
            totalEnabled = on;
            if (!on) {
                if (focusEnabled) setFocusEnabled(false);
                setContentVisibility(layers.contentVisibility, false);
                setDamper(layers.damper, false);
                setDisplayEnabled(layers.display, false);
            } else {
                setDamper(layers.damper, false);
                setContentVisibility(layers.contentVisibility, false);
                setDisplayEnabled(layers.display, false);
            }
            updateUi();
        };

        // 控件使用独立样式边界，不更改 ChatGPT 的输入框、按钮或消息内容。
        const panelStyle = ':host { position:fixed; right:12px; top:78px; z-index:2147483000;'
            + ' color-scheme:light dark; font:12px/1.5 system-ui,sans-serif; }\n'
            + 'details { max-width:260px; border:1px solid #8886; border-radius:10px;'
            + ' background:Canvas; color:CanvasText; box-shadow:0 2px 10px #0001; }\n'
            + 'summary { padding:7px 10px; cursor:pointer; user-select:none; }\n'
            + 'section { padding:0 10px 10px; display:grid; gap:7px; }\n'
            + 'button { font:inherit; padding:5px 8px; cursor:pointer; }\n'
            + 'p { margin:0; overflow-wrap:anywhere; }\n'
            + '@media print { :host { display:none; } }';
        const renderStyle = document.createElement('style');
        renderStyle.id = 'cgpt-long-chat-lite-style';
        renderStyle.textContent = 'main .' + marker + ' { content-visibility:auto !important;'
            + ' contain-intrinsic-block-size:auto var(' + heightProperty + ', 600px) !important; }\n'
            + 'main .' + marker + ':hover, main .' + marker + ':focus-within,\n'
            + 'main .' + marker + ':has([contenteditable="true"]),\n'
            + 'main .' + marker + ':has([aria-expanded="true"]),\n'
            + 'main .' + marker + ':has([role="dialog"]), main .' + marker + ':has([role="menu"]) { content-visibility:visible !important; }\n'
            + '@media print { main .' + marker + ' { content-visibility:visible !important; } }';
        const focusStyle = document.createElement('style');
        focusStyle.id = 'cgpt-long-chat-lite-focus-style';
        focusStyle.textContent = 'main [data-chatgpt-search-unit-key$=":assistant"],'
            + ' main [data-message-author-role="assistant"] { display:none !important; }';

        // 轻量显示：旧回答泊车 + 最新回答静态孪生 + 块级延迟渲染。
        // 只在真实 ChatGPT 页面启用；本地普通夹具不会触发，显示层专项夹具会显式开启。
        /** @type {{turn: HTMLElement, clone: HTMLElement, signature: number, turnHeight: number, displayValue: string, displayPriority: string} | null} */
        let shieldState = null;
        /** @type {Map<HTMLElement, {placeholder: HTMLElement, observer: IntersectionObserver | null, displayValue: string, displayPriority: string}>} */
        const parkedTurns = new Map();
        /** @type {Element | null} */
        let displayScrollRoot = null;
        /** @type {MutationObserver | null} */
        let displayObserver = null;
        /** @type {Element | null} */
        let displayObservedMain = null;
        let displayInterval = 0;
        let displayScrollTimer = 0;
        let displayHealthTimer = 0;
        let displayHealthCheckTimer = 0;
        let displayHealthMisses = 0;
        let displayEnabled = false;
        let displayPausedUntil = 0;
        let displayActivationTimer = 0;
        let displayCandidateSize = 0;
        let displayStableChecks = 0;
        let displayActivationAttempts = 0;
        let displayActivationError = '';
        let displayNextAttemptAt = 0;
        let autoRestoreParked = true;
        let displayScrollingUntil = 0;
        // 内容增长检测：只在原回答真的比孪生更长时撤销孪生。
        // 页面在回答被隐藏后会做一次懒渲染收缩，长度会短暂变小；只比较「超过建孪生时的长度」可避免自激循环。
        let shieldContentLength = 0;
        let shieldAllowedAt = 0;
        let contentCheckTimer = 0;
        /** @type {MutationObserver | null} */
        let growthObserver = null;
        // 交互回答专注模式：在回答内的输入框里打字时，把其它回答临时收起（等高占位）并隐藏静态孪生，
        // 让页面每次按键的样式重算只覆盖正在编辑的这一条。
        /** @type {HTMLElement | null} */
        let focusModeTurn = null;
        /** @type {{turn: HTMLElement, placeholder: HTMLElement, displayValue: string, displayPriority: string}[]} */
        let focusParked = [];
        // 记录「被专注模式隐藏的那个副本元素」本身，而不是布尔标志：
        // 副本在退出瞬间可能已脱离 DOM，布尔标志会漏恢复，之后 repair 把它插回就带着
        // display:none，最新回答会整条空白。
        /** @type {HTMLElement | null} */
        let focusHiddenTwin = null;
        let focusRestoreTimer = 0;
        // 输入期间让路：按键/合成输入后 300 ms 内跳过周期刷新，避免和用户输入抢主线程。
        let inputBusyUntil = 0;
        for (const type of ['keydown', 'input', 'compositionstart', 'compositionupdate']) {
            document.addEventListener(type, () => {
                inputBusyUntil = performance.now() + 300;
            }, {capture: true, passive: true});
        }
        const displayCounters = {
            shield: 0, unshield: 0, park: 0, unpark: 0, refresh: 0, reattach: 0,
            contentUnshield: 0, focusEnter: 0, focusExit: 0,
            // 点击转发观测：主路径成功 / 兜底重试成功 / 最终丢弃（不点击）
            forwardFirst: 0, forwardRetry: 0, forwardDropped: 0
        };
        // 最近一次被「放出来」让用户操作的回答：期间用户在原节点上动手就持续续期，避免 10 秒后被打断。
        /** @type {HTMLElement | null} */
        let releasedTurn = null;

        const isChatGptHost = () => location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com')
            || testDisplayEnabled;

        const getAssistantTurns = () => findTurns().filter((turn) => turn.matches('[data-chatgpt-search-unit-key$=":assistant"], [data-message-author-role="assistant"]')
            || Boolean(turn.querySelector('[data-message-author-role="assistant"]')));

        const hasAssistantTurns = () => isChatGptHost() && getAssistantTurns().length > 0;

        // 写作块：新版 ChatGPT 把回答正文渲染在可编辑的 ProseMirror 里。克隆时把它降级为
        // 只读预览，用户点进去时再放出原节点，这样这类回答也能享受静态副本优化。
        const writingBlockSelector = '.ProseMirror[contenteditable="true"][role="textbox"]';
        const readOnlyBlockSelector = '[data-lcl-readonly]';

        // 含「复制后必然失效」内容的回答不建静态副本：
        // - 输入控件：副本里打不了字；
        // - 拖曳型控件：副本没有 React 事件绑定，拖拽无法靠 click 转发；
        // - iframe/canvas/video：克隆会重新加载 / 变空白 / 点击失效。
        // 写作块是例外：降级成只读预览后可以安全克隆，点击时再放出原节点。
        // 引用角标 span[role=button] 不属于这一类：点击时语义定位后转发，弹层位置正确。
        // 并入同一入口（而非新增判断），刷新与健康检查会自动保持一致。
        /** @param {HTMLElement} turn @returns {boolean} */
        const hasUncloneableContent = (turn) => Boolean(turn.querySelector(
            'input:not([type="hidden"]), textarea, select,'
            + ' [contenteditable]:not([contenteditable="false"]):not(.ProseMirror[contenteditable="true"][role="textbox"]),'
            + ' [role="slider"], [role="spinbutton"], [role="scrollbar"], [draggable="true"],'
            + ' iframe, canvas, video, audio, embed, object'));

        // 停车阈值要判断整条会话的规模；全树计数是 16k 级数组，不能每次刷新或定时重算。
        // 只在「回答数量变化」时重算一次：新回答到达才可能改变会话规模。
        let threadSizeCache = 0;
        let threadSizeTurns = -1;
        const getThreadSize = () => {
            const assistants = getAssistantTurns();
            if (assistants.length === threadSizeTurns) return threadSizeCache;
            const main = document.querySelector('main');
            const twin = main?.querySelector('[data-lcl-twin]');
            const twinNodes = twin ? twin.querySelectorAll('*').length + 1 : 0;
            threadSizeCache = main ? main.querySelectorAll('*').length - twinNodes : 0;
            threadSizeTurns = assistants.length;
            return threadSizeCache;
        };

        // 最新回答始终使用静态副本；旧回答只在确实会拖慢页面的多回答会话里收起。
        const shouldParkOldAnswers = () => {
            const assistants = getAssistantTurns();
            if (assistants.length < 2) return false;
            if (getThreadSize() >= 5000) return true;
            return assistants.slice(0, -1).some((turn) => turn.querySelectorAll('*').length >= 1500);
        };

        /** @param {HTMLElement} turn */
        const isStreamingTurn = (turn) => turn.getAttribute('aria-busy') === 'true'
            || Boolean(turn.querySelector('[data-result-streaming], [data-message-streaming], [data-streaming="true"], .result-streaming, .streaming'));

        // 新版页面在流式输出时不再给回答节点挂 aria-busy/data-streaming；唯一稳定信号是输入区的「停止」按钮。
        // 只认消息子树之外、且真实可见的按钮，避免克隆内容或回答内同名按钮造成误判。
        const isPageGenerating = () => {
            const buttons = document.querySelectorAll('button[aria-label="停止"], button[aria-label="Stop"],'
                + ' button[aria-label="Stop generating"], button[data-testid="stop-button"],'
                + ' button[data-testid="composer-stop-button"]');
            for (const button of buttons) {
                if (button.closest('[data-lcl-twin], [data-chatgpt-search-unit-key], [data-message-author-role],'
                    + ' [data-testid^="conversation-turn-"]')) continue;
                if (button.getClientRects().length) return true;
            }
            return false;
        };

        // 第二重保险：即使所有标记都失效，只要最新回答的文字在最近 3 秒内增长过，就仍视为生成中。
        // 用历史最大值比较，避免页面隐藏回答后的懒渲染收缩被误判成「没有增长」。
        /** @type {HTMLElement | null} */
        let growthTurn = null;
        let growthMaxLength = 0;
        let growthAt = -Infinity;
        let stopButtonSeenAt = -Infinity;
        // 最后一次增长发生在「停止按钮最后出现 + 800ms」内，说明生成刚结束，用短窗口；
        // 之后仍有增长，说明可能是没有按钮的生成（或选择器失配），回到 3 秒兜底。
        const growthWindowMs = () => (growthAt <= stopButtonSeenAt + 800 ? 800 : 3000);
        /** @param {HTMLElement} latest */
        const isLatestGenerating = (latest) => {
            if (!latest) return false;
            // 即使停止按钮命中，也持续更新增长基线：按钮消失后窗口从最后一次真实增长算起，
            // 而不是从「按钮消失后的第一次采样」算起。
            const length = (latest.textContent ?? '').length;
            if (latest !== growthTurn) {
                // 切换回答/会话时只重置基线，不把两个不同回答的长度差算成「增长」。
                growthTurn = latest;
                growthMaxLength = length;
            } else if (length > growthMaxLength) {
                growthMaxLength = length;
                growthAt = performance.now();
            }
            if (isStreamingTurn(latest)) return true;
            if (isPageGenerating()) {
                stopButtonSeenAt = performance.now();
                return true;
            }
            return performance.now() - growthAt < growthWindowMs();
        };

        const ensureDisplayScrollRoot = () => {
            if (displayScrollRoot?.isConnected) return displayScrollRoot;
            const first = getAssistantTurns()[0];
            displayScrollRoot = first ? findScrollRoot(first) : document.querySelector('.thread-scroll-container');
            return displayScrollRoot;
        };

        /** @param {HTMLElement} clone */
        const remapCloneIds = (clone) => {
            /** @type {Map<string, string>} */
            const ids = new Map();
            let index = 0;
            for (const element of clone.querySelectorAll('[id]')) {
                const oldId = element.id;
                if (!oldId) continue;
                const newId = 'cgpt-lcl-twin-' + (index++);
                ids.set(oldId, newId);
                element.id = newId;
            }
            if (!ids.size) return;
            for (const element of clone.querySelectorAll('[for], [aria-labelledby], [aria-describedby], [aria-controls], [aria-owns], [headers]')) {
                for (const attribute of ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'headers']) {
                    const value = element.getAttribute(attribute);
                    if (!value) continue;
                    const mapped = value.split(/\s+/).map((part) => ids.get(part) ?? part).join(' ');
                    if (mapped !== value) element.setAttribute(attribute, mapped);
                }
            }
            for (const anchor of clone.querySelectorAll('a[href^="#"]')) {
                const href = anchor.getAttribute('href');
                const oldId = href?.slice(1);
                const newId = oldId ? ids.get(oldId) : null;
                if (newId) anchor.setAttribute('href', '#' + newId);
            }
        };

        /** @param {HTMLElement} clone */
        const applyCloneBlockVisibility = (clone) => {
            /** @param {HTMLElement} element @param {number} depth @returns {HTMLElement | null} */
            const walk = (element, depth) => {
                if (depth > 10) return null;
                /** @type {HTMLElement | null} */
                let best = null;
                const rect = element.getBoundingClientRect();
                if (rect.height > 3000 && element.children.length >= 20) best = element;
                for (const child of element.children) {
                    if (!(child instanceof HTMLElement)) continue;
                    const found = walk(child, depth + 1);
                    if (found && (!best || found.children.length > best.children.length)) best = found;
                }
                return best;
            };
            const container = walk(clone, 0);
            if (!container) return 0;
            let count = 0;
            for (const element of container.children) {
                if (!(element instanceof HTMLElement)) continue;
                const rect = element.getBoundingClientRect();
                if (rect.height < 16) continue;
                const display = getComputedStyle(element).display;
                if (display === 'inline' || display === 'contents') continue;
                element.style.setProperty('contain-intrinsic-block-size', 'auto ' + rect.height.toFixed(2) + 'px', 'important');
                element.style.setProperty('content-visibility', 'auto', 'important');
                count += 1;
            }
            return count;
        };

        // 页面在回答被隐藏后会做一次懒渲染收缩（节点数上下浮动百余），所以只在
        // 「原回答文本比建孪生时更长」时才撤销孪生，避免隐藏/恢复自激循环。
        const checkContentGrowth = () => {
            contentCheckTimer = 0;
            if (!shieldState) return;
            const length = (shieldState.turn.textContent ?? '').length;
            if (length <= shieldContentLength) return;
            unshieldTurn();
            shieldAllowedAt = performance.now() + 2000;
            displayCounters.contentUnshield += 1;
        };

        /** @param {HTMLElement} turn */
        const watchContentGrowth = (turn) => {
            unwatchContentGrowth();
            growthObserver = new NativeMutationObserver(() => {
                if (contentCheckTimer) return;
                contentCheckTimer = window.setTimeout(checkContentGrowth, 120);
            });
            // 只观察节点增删：流式追加与页面重渲染都会新增节点，不必额外监听字符数据。
            growthObserver.observe(turn, {childList: true, subtree: true});
        };

        const unwatchContentGrowth = () => {
            growthObserver?.disconnect();
            growthObserver = null;
            if (contentCheckTimer) {
                window.clearTimeout(contentCheckTimer);
                contentCheckTimer = 0;
            }
        };

        // 转发与校验共用的可交互元素选择器。补齐 role 系列与 label：
        // 0.6.1 只认 a/button/[role=button]/summary，会漏掉单选、标签、菜单项、Tabs。
        const interactiveSelector = 'a, button, summary, label, input, textarea, select,'
            + ' [role="button"], [role="link"], [role="radio"], [role="checkbox"], [role="switch"],'
            + ' [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"],'
            + ' [role="option"], [role="treeitem"], [role="combobox"]';

        /** @param {Element} element */
        const normalizeText = (element) => (element.textContent || '').replace(/\s+/g, ' ').trim();

        // 不上 id（副本已重映射）、不上 aria-checked/disabled（隐藏期可能过期）。
        /** @param {Element} element */
        const interactiveFingerprint = (element) => [
            element.tagName,
            element.getAttribute('role') || '',
            element.getAttribute('aria-label') || '',
            (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
        ].join('|');

        // 语义定位：**全文一致 + 全部可交互元素指纹序列一致** 才允许按序号反查。
        // 单看数量/单个指纹挡不住「题干已换、选项文本相同」的误选（判断题尤其危险）。
        /** @param {Element} clone @param {HTMLElement | null} turn @param {Element} target @returns {HTMLElement | null} */
        const resolveOriginalNode = (clone, turn, target) => {
            if (!turn || !turn.isConnected) return null;
            if (normalizeText(clone) !== normalizeText(turn)) return null;
            const from = clone.querySelectorAll(interactiveSelector);
            const to = turn.querySelectorAll(interactiveSelector);
            if (from.length === 0 || from.length !== to.length) return null;
            for (let index = 0; index < from.length; index += 1) {
                if (interactiveFingerprint(from[index]) !== interactiveFingerprint(to[index])) return null;
            }
            const position = Array.prototype.indexOf.call(from, target);
            if (position < 0) return null;
            const candidate = to[position];
            return candidate instanceof HTMLElement && candidate.isConnected ? candidate : null;
        };

        // 只有「控件带状态属性、普通 click 之后状态没变」才补发指针序列。
        // 补发里**不再发 click**，避免「提交答案」这类按钮被激活两次。
        /** @param {HTMLElement} element */
        const activateElement = (element) => {
            const stateAttr = element.hasAttribute('aria-expanded') ? 'aria-expanded'
                : element.getAttribute('role') === 'tab' ? 'aria-selected'
                    : null;
            if (!stateAttr) {
                element.focus({preventScroll: true});
                element.click();
                return;
            }
            const before = element.getAttribute(stateAttr);
            element.focus({preventScroll: true});
            element.click();
            // React 18 的离散事件在微任务里提交：click() 之后同步读属性拿到的还是旧值，
            // 直接判断会让「同时响应 click 与 pointerdown」的控件被切换两次（开了又关）。
            // 因此延迟一拍再判断，且只在状态确实没变时才补发指针序列。
            window.setTimeout(() => {
                if (!element.isConnected) return;
                if (element.getAttribute(stateAttr) !== before) return;
                const rect = element.getBoundingClientRect();
                const base = {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
                    button: 0
                };
                element.dispatchEvent(new PointerEvent('pointerdown', {...base, buttons: 1, pointerType: 'mouse', isPrimary: true}));
                element.dispatchEvent(new MouseEvent('mousedown', {...base, buttons: 1}));
                element.dispatchEvent(new PointerEvent('pointerup', {...base, buttons: 0, pointerType: 'mouse', isPrimary: true}));
                element.dispatchEvent(new MouseEvent('mouseup', {...base, buttons: 0}));
            }, 50);
        };

        // 副本重建前的安全闸。三件事都不能重建：
        // ① 弹层开着（锚点消失会让弹层跳位或关闭）；② 焦点在回答内（用户可能正在用键盘操作）；
        // ③ 用户正在原节点上操作（按下与抬起之间重建会让这次点击丢失）。
        /** @param {HTMLElement | null} turn */
        const hasOpenPopupOutside = (turn) => {
            if (!turn || !turn.isConnected) return false;
            for (const trigger of turn.querySelectorAll('[aria-expanded="true"][aria-controls]')) {
                const id = trigger.getAttribute('aria-controls');
                if (!id) continue;
                const popup = document.getElementById(id);
                if (popup && !turn.contains(popup)) return true;
            }
            return false;
        };

        // 是否处于「键盘操作」上下文：不依赖 :focus-visible 对脚本 focus() 的继承规则
        // （那是浏览器实现细节，实测不确定，可能让副本永远建不回来）。
        let keyboardIntentUntil = 0;
        document.addEventListener('pointerdown', () => { keyboardIntentUntil = 0; }, {capture: true, passive: true});
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Tab' || event.key === 'Enter' || event.key === ' '
                || event.key.startsWith('Arrow')) {
                keyboardIntentUntil = performance.now() + 1500;
            }
        }, {capture: true, passive: true});

        /** @param {HTMLElement | null} turn @returns {boolean} 焦点是否在该回答内的可编辑区。 */
        const isEditingInside = (turn) => {
            if (!turn) return false;
            const active = document.activeElement;
            return active instanceof HTMLElement && active !== turn && turn.contains(active)
                && Boolean(active.closest('input, textarea, select, [contenteditable="true"]'));
        };

        /**
         * 把副本里的写作块降级为只读预览，并记录序号供释放时反查。
         * @param {HTMLElement} clone
         */
        const downgradeWritingBlocks = (clone) => {
            const blocks = clone.querySelectorAll(writingBlockSelector);
            let index = 0;
            for (const block of blocks) {
                block.removeAttribute('contenteditable');
                block.removeAttribute('aria-multiline');
                block.removeAttribute('aria-placeholder');
                block.removeAttribute('spellcheck');
                block.removeAttribute('autocorrect');
                block.removeAttribute('autocapitalize');
                block.removeAttribute('data-placeholder');
                // 去掉 ProseMirror 的编辑态类，避免副本看起来可编辑。
                block.classList.remove('ProseMirror-focused', 'ProseMirror-hideselection', 'ProseMirror-selectednode');
                block.setAttribute('data-lcl-readonly', '1');
                block.setAttribute('data-lcl-readonly-index', String(index++));
                block.setAttribute('role', 'group');
                block.setAttribute('aria-label', '写作块（只读预览，点击或按 Enter 进入编辑）');
                block.setAttribute('tabindex', '0');
            }
        };

        /**
         * 放出原节点并把焦点交给对应的原编辑器。
         * @param {HTMLElement} clone @param {Element} block @param {{x: number, y: number} | null} point
         */
        const releaseWritingBlock = (clone, block, point) => {
            const activeState = shieldState;
            if (!activeState || activeState.clone !== clone) return;
            const index = Number(block.getAttribute('data-lcl-readonly-index') || 0);
            const {turn} = activeState;
            shieldAllowedAt = Math.max(shieldAllowedAt, performance.now() + 10000);
            releasedTurn = turn;
            unshieldTurn();
            if (!turn.isConnected) return;
            const editors = turn.querySelectorAll(writingBlockSelector);
            /** @type {Element | undefined} */
            let editor = editors[index];
            if (!(editor instanceof HTMLElement)) {
                // 原节点可能已被 React 替换：退回当前最后一条回答里的同序号写作块。
                const liveTurn = getAssistantTurns().slice(-1)[0];
                const fallback = liveTurn && liveTurn !== turn
                    ? liveTurn.querySelectorAll(writingBlockSelector)[index]
                    : undefined;
                if (fallback instanceof HTMLElement) editor = fallback;
            }
            if (!(editor instanceof HTMLElement)) return;
            editor.focus({preventScroll: true});
            if (!point || typeof document.caretRangeFromPoint !== 'function') return;
            const range = document.caretRangeFromPoint(point.x, point.y);
            if (!range || !editor.contains(range.startContainer)) return;
            const selection = window.getSelection();
            if (!selection) return;
            selection.removeAllRanges();
            selection.addRange(range);
        };

        /** @param {HTMLElement | null} turn @returns {boolean} */
        const canShieldNow = (turn) => {
            if (performance.now() < shieldAllowedAt) return false;
            if (isEditingInside(turn)) return false;
            if (hasOpenPopupOutside(turn)) return false;
            if (performance.now() < keyboardIntentUntil
                && turn && turn.isConnected && turn.contains(document.activeElement)) return false;
            return true;
        };

        // 用户在「已放出的回答」上继续操作时，持续续期，避免到 10 秒被打断。
        document.addEventListener('pointerdown', (event) => {
            if (!(event.target instanceof Node)) return;
            if (releasedTurn && releasedTurn.isConnected && releasedTurn.contains(event.target)) {
                shieldAllowedAt = Math.max(shieldAllowedAt, performance.now() + 10000);
            }
        }, {capture: true, passive: true});
        // 键盘输入与焦点落在放出中的回答里也要续期：否则长文本写到一半，压制期一过就会被重新隐藏。
        for (const type of ['keydown', 'input', 'focusin']) {
            document.addEventListener(type, () => {
                const active = document.activeElement;
                if (releasedTurn && releasedTurn.isConnected && active instanceof Node
                    && releasedTurn.contains(active)) {
                    shieldAllowedAt = Math.max(shieldAllowedAt, performance.now() + 10000);
                }
            }, {capture: true, passive: true});
        }

        /** @param {HTMLElement} turn */
        const shieldTurn = (turn) => {
            if (!turn.isConnected) return;
            // 先判断再克隆：否则 iframe 会先被克隆触发重新加载，随后才被撤销。
            if (hasUncloneableContent(turn)) return;
            // 用户正在该回答里编写：保留原节点，避免把输入焦点和 IME 组字打断。
            if (isEditingInside(turn)) return;
            if (shieldState?.turn === turn && shieldState.clone.isConnected) return;
            unshieldTurn();
            const parent = turn.parentElement;
            if (!parent) return;
            // 若该回答正被专注模式收起，必须先放出来再克隆：
            // 否则 cloneNode 会把收起时加的 display:none !important 一起复制给副本，
            // 原节点与副本同时隐藏 → 这条回答永久空白。
            const focusEntryIndex = focusParked.findIndex((entry) => entry.turn === turn);
            if (focusEntryIndex >= 0) {
                const [focusEntry] = focusParked.splice(focusEntryIndex, 1);
                focusEntry.placeholder.remove();
                if (focusEntry.displayValue) turn.style.setProperty('display', focusEntry.displayValue, focusEntry.displayPriority);
                else turn.style.removeProperty('display');
            }
            const displayValue = turn.style.getPropertyValue('display');
            const displayPriority = turn.style.getPropertyPriority('display');
            const turnHeight = turn.getBoundingClientRect().height;
            const signature = turn.textContent?.length ?? 0;
            shieldContentLength = signature;
            watchContentGrowth(turn);
            const clone = /** @type {HTMLElement} */ (turn.cloneNode(true));
            clone.setAttribute('data-lcl-twin', '1');
            clone.removeAttribute('data-chatgpt-search-unit-key');
            clone.removeAttribute('data-message-author-role');
            clone.removeAttribute('data-testid');
            for (const element of clone.querySelectorAll('[data-chatgpt-search-unit-key], [data-message-author-role], [data-testid^="conversation-turn-"]')) {
                element.removeAttribute('data-chatgpt-search-unit-key');
                element.removeAttribute('data-message-author-role');
                element.removeAttribute('data-testid');
            }
            remapCloneIds(clone);
            // 写作块在副本里只能当只读预览：保留文字与样式，去掉可编辑语义。
            downgradeWritingBlocks(clone);
            // 重建时若焦点在回答内，按子节点索引把焦点交给副本，避免焦点掉到 BODY
            // （键盘用户 Tab 后停顿、或鼠标转发后焦点留在原节点都会触发）。
            /** @type {number[] | null} */
            let focusPath = null;
            const focused = document.activeElement;
            if (focused instanceof HTMLElement && focused !== turn && turn.contains(focused)) {
                focusPath = [];
                for (let node = /** @type {HTMLElement | null} */ (focused); node && node !== turn; node = node.parentElement) {
                    focusPath.unshift(Array.prototype.indexOf.call(node.parentElement?.children ?? [], node));
                }
            }
            parent.insertBefore(clone, turn.nextSibling);
            turn.style.setProperty('display', 'none', 'important');
            if (focusPath) {
                /** @type {Element | undefined} */
                let mirror = clone;
                for (const index of focusPath) mirror = mirror?.children[index];
                if (mirror instanceof HTMLElement) mirror.focus({preventScroll: true});
            }
            turn.dataset.lclShielded = '1';
            const cvCount = applyCloneBlockVisibility(clone);
            clone.dataset.lclCvBlocks = String(cvCount);
            const adjustCloneHeight = () => {
                if (!shieldState || shieldState.clone !== clone || !clone.isConnected) return;
                const cloneHeight = clone.getBoundingClientRect().height;
                const delta = cloneHeight - turnHeight;
                if (Math.abs(delta) < 1) return;
                const marginBottom = parseFloat(getComputedStyle(clone).marginBottom) || 0;
                clone.style.setProperty('margin-bottom', (marginBottom - delta).toFixed(2) + 'px', 'important');
            };
            adjustCloneHeight();
            // 拖曳型控件无法用选择器穷举（例如纯 SVG/div 手柄）：副本收到 pointerdown 且目标呈
            // 可拖曳光标时，立刻放出原节点，由用户重新拖一次。与 cursor:pointer 的点击补救同一思路。
            clone.addEventListener('pointerdown', (event) => {
                if (!shieldState || shieldState.clone !== clone) return;
                if (event.button !== 0 || event.isPrimary === false) return;
                const target = event.target instanceof Element ? event.target : null;
                if (!target || !clone.contains(target)) return;
                const cursor = getComputedStyle(target).cursor;
                if (cursor !== 'grab' && cursor !== 'grabbing'
                    && cursor !== 'ew-resize' && cursor !== 'col-resize') return;
                event.preventDefault();
                event.stopPropagation();
                shieldAllowedAt = Math.max(shieldAllowedAt, performance.now() + 10000);
                releasedTurn = shieldState?.turn ?? null;
                unshieldTurn();
                displayCounters.forwardDropped += 1;
            });
            // 写作块是只读预览：点击（且不在选字中）或键盘进入时放出原节点，由用户就地编辑。
            clone.addEventListener('click', (event) => {
                if (!shieldState || shieldState.clone !== clone) return;
                const target = event.target instanceof Element ? event.target : null;
                if (!target) return;
                const block = target.closest(readOnlyBlockSelector);
                if (!(block instanceof Element) || !clone.contains(block)) return;
                // 双击/三击选字：第一击时选区还是折叠的，不能提前释放。
                if (event.detail > 1) return;
                // 块内的按钮/菜单项交给既有点击桥接，保持「点一次就生效」。
                if (target.closest('button, [role="button"], summary')) return;
                const selection = window.getSelection();
                // 正在块内选字复制时不释放，交给浏览器原生选区。
                if (selection && !selection.isCollapsed && selection.anchorNode instanceof Node
                    && block.contains(selection.anchorNode)) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                releaseWritingBlock(clone, block, {x: event.clientX, y: event.clientY});
            }, true);
            clone.addEventListener('keydown', (event) => {
                if (!shieldState || shieldState.clone !== clone) return;
                const block = event.target instanceof Element
                    ? event.target.closest(readOnlyBlockSelector)
                    : null;
                if (!(block instanceof Element) || !clone.contains(block)) return;
                // IME 组字、退格/删除、粘贴/剪切、Enter/空格、可打印字符都视为进入编辑。
                const editingKey = event.isComposing || event.keyCode === 229
                    || event.key === 'Enter' || event.key === ' '
                    || event.key === 'Backspace' || event.key === 'Delete'
                    || ((event.ctrlKey || event.metaKey) && (event.key === 'v' || event.key === 'x'))
                    || (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey);
                if (!editingKey) return;
                event.preventDefault();
                event.stopPropagation();
                releaseWritingBlock(clone, block, null);
            }, true);
            clone.addEventListener('click', (event) => {
                const target = event.target instanceof Element
                    ? event.target.closest(interactiveSelector)
                    : null;
                // closest 可能越出副本命中外层祖先：那样点普通文字也会释放副本，必须拦住。
                if (target instanceof HTMLElement && !clone.contains(target)) return;
                if (!(target instanceof HTMLElement)) {
                    // 无语义但看起来可点的元素（cursor:pointer）：至少把原节点放出来，由用户再点一次。
                    const pointed = event.target instanceof Element
                        && getComputedStyle(event.target).cursor === 'pointer';
                    if (pointed && shieldState) {
                        event.preventDefault();
                        event.stopPropagation();
                        shieldAllowedAt = Math.max(shieldAllowedAt, performance.now() + 10000);
                        releasedTurn = shieldState.turn;
                        unshieldTurn();
                        displayCounters.forwardDropped += 1;
                    }
                    return;
                }
                if (target.tagName === 'A') {
                    const href = target.getAttribute('href');
                    // 同源链接交给页面自身处理（原地导航），外链/带协议才放行。
                    if (href && !href.startsWith('#')) {
                        let sameOrigin = false;
                        try {
                            sameOrigin = new URL(href, location.href).origin === location.origin;
                        } catch { sameOrigin = false; }
                        if (!sameOrigin) return;
                    }
                }
                const activeState = shieldState;
                if (!activeState) return;
                // 顺序很重要：先拦事件、再压制重建、最后才取局部引用（unshieldTurn 会清空 shieldState）。
                event.preventDefault();
                event.stopPropagation();
                const {turn: originalTurn, clone: twinClone} = activeState;
                // 成功失败都压制重建：否则放出原节点后可能立刻又被隐藏，「再点一次」就不成立。
                shieldAllowedAt = Math.max(shieldAllowedAt, performance.now() + 10000);

                releasedTurn = originalTurn;
                const first = resolveOriginalNode(twinClone, originalTurn, target);
                unshieldTurn();
                if (first && first.isConnected) {
                    displayCounters.forwardFirst += 1;
                    activateElement(first);
                    return;
                }

                // 兜底：隐藏期懒渲染收缩会让内容暂时缺失，放出后再定位。
                // 三条硬约束：① 用户一动手就取消；② 标签页隐藏时暂停（rAF 在后台被节流，
                // 切回来会先于用户的 pointerdown 触发，可能替他点下去）；③ 最多等 400ms，
                // 超过就放弃，避免「很久之后突然点一下」。
                let cancelled = false;
                const cancelRetry = () => { cancelled = true; };
                const cleanupRetry = () => {
                    document.removeEventListener('pointerdown', cancelRetry, true);
                    document.removeEventListener('keydown', cancelRetry, true);
                };
                document.addEventListener('pointerdown', cancelRetry, {capture: true, once: true});
                document.addEventListener('keydown', cancelRetry, {capture: true, once: true});
                const retryDeadline = performance.now() + 400;
                const retryTick = () => {
                    if (cancelled || document.hidden || performance.now() > retryDeadline) {
                        cleanupRetry();
                        if (!cancelled) displayCounters.forwardDropped += 1;
                        return;
                    }
                    // 原节点可能已被 React 整棵替换：退回到当前最后一条回答再试。
                    const liveTurn = originalTurn.isConnected
                        ? originalTurn
                        : (getAssistantTurns().slice(-1)[0] ?? null);
                    const retry = resolveOriginalNode(twinClone, liveTurn, target);
                    if (retry) {
                        cleanupRetry();
                        displayCounters.forwardRetry += 1;
                        activateElement(retry);
                        return;
                    }
                    requestAnimationFrame(retryTick);
                };
                requestAnimationFrame(retryTick);
            }, true);
            shieldState = {turn, clone, signature, turnHeight, displayValue, displayPriority};
            // 专注模式期间副本被重建：新副本必须同样是隐藏的。
            // 必须放在 adjustCloneHeight() 之后——先隐藏会让高度量成 0，
            // margin-bottom 会被补偿一整个回答的高度，退出后留下大块空白。
            if (focusModeTurn?.isConnected && !turn.contains(focusModeTurn)) hideTwinForFocus();
            displayCounters.shield += 1;
            updateUi();
        };

        const unshieldTurn = () => {
            if (!shieldState) return;
            const {turn, clone, displayValue, displayPriority} = shieldState;
            shieldState = null;
            unwatchContentGrowth();
            displayCounters.unshield += 1;
            clone.remove();
            if (turn.isConnected) {
                if (displayValue) turn.style.setProperty('display', displayValue, displayPriority);
                else turn.style.removeProperty('display');
                delete turn.dataset.lclShielded;
            }
            updateUi();
        };

        /** @param {HTMLElement} turn */
        const parkTurn = (turn) => {
            if (parkedTurns.has(turn) || !turn.isConnected || turn === shieldState?.turn || turn.dataset.lclManual === '1' || isStreamingTurn(turn)) return;
            if (turn.querySelector('[contenteditable="true"]')) return;
            // 刚被自动恢复的回答先保持可见，避免与恢复逻辑互相拉扯。
            if (Number(turn.dataset.lclUnparkedAt || 0) + 3000 > performance.now()) return;
            const rect = turn.getBoundingClientRect();
            if (rect.height < 40) return;
            const parent = turn.parentElement;
            if (!parent) return;
            const scrollRoot = ensureDisplayScrollRoot();
            const scrollTop = scrollRoot instanceof Element ? scrollRoot.scrollTop : null;
            const beforeHeight = scrollRoot instanceof Element ? scrollRoot.scrollHeight : null;
            const placeholder = document.createElement('div');
            placeholder.className = 'cgpt-lcl-parked';
            placeholder.setAttribute('role', 'group');
            placeholder.setAttribute('aria-label', '已收起的历史回答');
            placeholder.style.cssText = 'display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;'
                + 'height:' + rect.height.toFixed(2) + 'px;box-sizing:border-box;padding:14px 16px;'
                + 'border:1px dashed rgba(127,127,127,.35);border-radius:8px;color:inherit;opacity:.72;'
                + 'font:12px/1.5 system-ui,sans-serif;cursor:pointer;user-select:none;';
            const placeholderLabel = document.createElement('span');
            placeholderLabel.textContent = '历史回答已收起；滚动到此处自动恢复';
            placeholderLabel.style.cssText = 'position:sticky;top:10px;padding:6px 10px;border-radius:999px;'
                + 'background:Canvas;color:CanvasText;border:1px solid #8884;';
            placeholder.append(placeholderLabel);
            const displayValue = turn.style.getPropertyValue('display');
            const displayPriority = turn.style.getPropertyPriority('display');
            placeholder.addEventListener('click', () => {
                turn.dataset.lclManual = '1';
                unparkTurn(turn);
            });
            parent.insertBefore(placeholder, turn);
            turn.dataset.lclParked = '1';
            turn.style.setProperty('display', 'none', 'important');
            const afterHeight = scrollRoot instanceof Element ? scrollRoot.scrollHeight : null;
            if (beforeHeight !== null && afterHeight !== null && afterHeight !== beforeHeight) {
                const adjusted = Math.max(0, rect.height + (beforeHeight - afterHeight));
                placeholder.style.height = adjusted.toFixed(2) + 'px';
            }
            if (scrollRoot instanceof Element && scrollTop !== null && Math.abs(scrollRoot.scrollTop - scrollTop) > 1) {
                scrollRoot.scrollTop = scrollTop;
            }
            /** @type {IntersectionObserver | null} */
            let observer = null;
            if (autoRestoreParked && typeof IntersectionObserver === 'function') {
                observer = new IntersectionObserver((entries) => {
                    if (entries.some((entry) => entry.isIntersecting)) unparkTurn(turn);
                }, {root: scrollRoot instanceof Element ? scrollRoot : null, rootMargin: '25% 0px'});
                observer.observe(placeholder);
            }
            parkedTurns.set(turn, {placeholder, observer, displayValue, displayPriority});
            displayCounters.park += 1;
            updateUi();
        };

        /** @param {HTMLElement} turn */
        const unparkTurn = (turn) => {
            const entry = parkedTurns.get(turn);
            if (!entry) return;
            turn.dataset.lclUnparkedAt = String(Math.round(performance.now()));
            parkedTurns.delete(turn);
            delete turn.dataset.lclParked;
            entry.observer?.disconnect();
            entry.placeholder.remove();
            if (turn.isConnected) {
                if (entry.displayValue) turn.style.setProperty('display', entry.displayValue, entry.displayPriority);
                else turn.style.removeProperty('display');
            }
            displayCounters.unpark += 1;
            updateUi();
        };

        // 停车规则与 v0.3.3 一致：在底部时，完全离开视口上方的旧回答都停车；
        // 不在底部时留 1.5 个视口余量。恢复由观察器负责（只在占位接近视口时恢复），
        // 加上"恢复后 3 秒内不再停车"的守卫，避免停车/恢复互相拉扯。
        /** @param {HTMLElement[]} assistants @param {HTMLElement} latest */
        const parkFarAnswers = (assistants, latest) => {
            const scrollRoot = ensureDisplayScrollRoot();
            if (!(scrollRoot instanceof Element)) return;
            const rootTop = scrollRoot.getBoundingClientRect().top;
            const atBottom = scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 80;
            const margin = atBottom ? 0 : Math.max(400, scrollRoot.clientHeight * 1.5);
            for (const turn of assistants) {
                if (turn === latest) continue;
                if (turn.getBoundingClientRect().bottom < rootTop - margin) parkTurn(turn);
            }
        };

        /** @param {Element | null} element @returns {boolean} */
        const isEditableElement = (element) => element instanceof HTMLElement
            && Boolean(element.closest('input, textarea, select, [contenteditable="true"]'));

        // 只有「位于某条助手回答内部」的可编辑元素才算正在编辑回答；主输入框不算。
        /** @param {Element | null} element @returns {HTMLElement | null} */
        const focusTurnOf = (element) => {
            if (!isEditableElement(element)) return null;
            const turn = /** @type {HTMLElement} */ (element).closest(messageSelector);
            return turn instanceof HTMLElement ? turn : null;
        };

        // 专注模式下隐藏最新回答的静态副本；若副本已被换掉，重新记一次。
        const hideTwinForFocus = () => {
            const clone = shieldState?.clone;
            if (!(clone instanceof HTMLElement)) return;
            if (focusHiddenTwin === clone && clone.style.getPropertyValue('display') === 'none') return;
            clone.style.setProperty('display', 'none', 'important');
            focusHiddenTwin = clone;
        };

        const exitFocusMode = () => {
            window.clearTimeout(focusRestoreTimer);
            focusRestoreTimer = 0;
            if (!focusModeTurn && !focusParked.length && !focusHiddenTwin) return;
            for (const entry of focusParked) {
                entry.placeholder.remove();
                if (entry.turn.isConnected) {
                    if (entry.displayValue) entry.turn.style.setProperty('display', entry.displayValue, entry.displayPriority);
                    else entry.turn.style.removeProperty('display');
                }
            }
            focusParked = [];
            // 不论副本此刻是否还在 DOM 上都要恢复：它可能马上被 repair 插回。
            if (focusHiddenTwin) focusHiddenTwin.style.removeProperty('display');
            focusHiddenTwin = null;
            focusModeTurn = null;
            displayCounters.focusExit += 1;
            updateUi();
        };

        /** @param {HTMLElement} turn */
        const enterFocusMode = (turn) => {
            if (!displayEnabled || !totalEnabled || !layers.display) return;
            if (focusModeTurn === turn) return;
            if (focusModeTurn) exitFocusMode();
            focusModeTurn = turn;
            displayCounters.focusEnter += 1;
            const scrollRoot = ensureDisplayScrollRoot();
            const scrollTop = scrollRoot instanceof Element ? scrollRoot.scrollTop : null;
            for (const other of getAssistantTurns()) {
                if (other === turn || other === shieldState?.turn || parkedTurns.has(other)) continue;
                // focusin 用 closest 取到的是最内层匹配，getAssistantTurns 返回最外层；
                // 两者存在包含关系时若继续处理，会把焦点所在回答的祖先也收起来，导致输入框消失。
                if (other.contains(turn) || turn.contains(other)) continue;
                if (!other.isConnected || other.dataset.lclManual === '1') continue;
                const rect = other.getBoundingClientRect();
                if (rect.height < 40) continue;
                const placeholder = document.createElement('div');
                placeholder.className = 'cgpt-lcl-focus-parked';
                placeholder.style.cssText = 'height:' + rect.height.toFixed(2) + 'px;';
                other.parentElement?.insertBefore(placeholder, other);
                focusParked.push({
                    turn: other,
                    placeholder,
                    displayValue: other.style.getPropertyValue('display'),
                    displayPriority: other.style.getPropertyPriority('display')
                });
                other.style.setProperty('display', 'none', 'important');
            }
            hideTwinForFocus();
            if (scrollRoot instanceof Element && scrollTop !== null) scrollRoot.scrollTop = scrollTop;
            updateUi();
        };

        const scheduleFocusExit = () => {
            if (!focusModeTurn) return;
            window.clearTimeout(focusRestoreTimer);
            focusRestoreTimer = window.setTimeout(() => {
                focusRestoreTimer = 0;
                if (focusTurnOf(document.activeElement)) return;
                exitFocusMode();
            }, 600);
        };

        const restoreAllParked = () => {
            for (const turn of Array.from(parkedTurns.keys())) unparkTurn(turn);
        };

        const restoreForSearch = () => {
            displayPausedUntil = performance.now() + 10000;
            unshieldTurn();
            restoreAllParked();
        };

        const repairDisplay = () => {
            if (shieldState) {
                if (!shieldState.clone.isConnected) {
                    if (shieldState.turn.isConnected) {
                        // React 重渲染可能移除克隆；先恢复原回答，滚动结束后再插回缓存的克隆，避免滚动中反复克隆。
                        if (shieldState.displayValue) shieldState.turn.style.setProperty('display', shieldState.displayValue, shieldState.displayPriority);
                        else shieldState.turn.style.removeProperty('display');
                        if (performance.now() >= displayScrollingUntil) {
                            const parent = shieldState.turn.parentElement;
                            if (parent) {
                                parent.insertBefore(shieldState.clone, shieldState.turn.nextSibling);
                                shieldState.turn.style.setProperty('display', 'none', 'important');
                                displayCounters.reattach += 1;
                            }
                        }
                    }
                } else if (shieldState.turn.isConnected) {
                    shieldState.turn.style.setProperty('display', 'none', 'important');
                }
            }
            for (const [turn, entry] of Array.from(parkedTurns.entries())) {
                if (!entry.placeholder.isConnected) {
                    parkedTurns.delete(turn);
                    delete turn.dataset.lclParked;
                    if (turn.isConnected) {
                        if (entry.displayValue) turn.style.setProperty('display', entry.displayValue, entry.displayPriority);
                        else turn.style.removeProperty('display');
                    }
                    continue;
                }
                if (!turn.isConnected) {
                    entry.observer?.disconnect();
                    entry.placeholder.remove();
                    parkedTurns.delete(turn);
                    continue;
                }
                turn.style.setProperty('display', 'none', 'important');
                if (entry.placeholder.nextSibling !== turn) turn.before(entry.placeholder);
            }
        };

        /** @param {HTMLElement} latest @returns {boolean} */
        const adoptShieldToLatest = (latest) => {
            if (!shieldState) return false;
            if (shieldState.turn === latest) return true;
            if (shieldState.turn.isConnected) return false;
            const nextSignature = latest.textContent?.length ?? 0;
            if (nextSignature !== shieldState.signature) return false;
            shieldState.turn = latest;
            shieldState.displayValue = latest.style.getPropertyValue('display');
            shieldState.displayPriority = latest.style.getPropertyPriority('display');
            shieldContentLength = nextSignature;
            watchContentGrowth(latest);
            latest.dataset.lclShielded = '1';
            latest.style.setProperty('display', 'none', 'important');
            latest.after(shieldState.clone);
            displayCounters.reattach += 1;
            return true;
        };

        const refreshDisplay = () => {
            if (!displayEnabled || !totalEnabled || !layers.display) return;
            if (performance.now() < displayPausedUntil) return;
            displayCounters.refresh += 1;
            repairDisplay();
            const assistants = getAssistantTurns();
            if (!assistants.length) return;
            const latest = assistants[assistants.length - 1];
            const generating = isLatestGenerating(latest);
            if (generating) {
                unshieldTurn();
                if (shouldParkOldAnswers()) parkFarAnswers(assistants, latest);
                // 增长窗口结束后若没有新的 DOM 变动，也要补一次刷新，避免副本迟迟不建立。
                scheduleGrowthRecheck();
                return;
            }
            if (shieldState && shieldState.turn !== latest) {
                if (!adoptShieldToLatest(latest)) {
                    // React 替换了最新回答节点：立刻重建孪生，不要留下 1.5～3 秒的无优化窗口。
                    unshieldTurn();
                    if (canShieldNow(latest)) shieldTurn(latest);
                }
            }
            if (isEditingInside(latest)) {
                // 用户正在回答里编写：先放出原节点，失焦后再重建副本。
                unshieldTurn();
                if (shouldParkOldAnswers()) parkFarAnswers(assistants, latest);
                updateUi();
                return;
            }
            if (hasUncloneableContent(latest)) {
                // 回答内部有可输入/可拖曳的控件：保留原节点，不能克隆。
                unshieldTurn();
                if (shouldParkOldAnswers()) parkFarAnswers(assistants, latest);
                updateUi();
                return;
            }
            if (!shieldState && canShieldNow(latest)) shieldTurn(latest);
            if (shouldParkOldAnswers()) parkFarAnswers(assistants, latest);
            updateUi();
        };

        /** @param {number} delay */
        const scheduleDisplay = (delay) => {
            window.clearTimeout(displayScrollTimer);
            displayScrollTimer = window.setTimeout(() => { displayScrollTimer = 0; refreshDisplaySafely(); }, delay);
        };

        // 增长窗口内不建立副本；窗口结束前补一次刷新，避免页面没有新的 DOM 变动时副本迟迟不建立。
        let growthRecheckTimer = 0;
        const scheduleGrowthRecheck = () => {
            if (growthRecheckTimer) return;
            const remaining = growthWindowMs() - (performance.now() - growthAt);
            // 窗口已过仍判为生成中，说明靠停止按钮等显式信号维持：低频轮询即可，避免 150ms 级刷新风暴。
            const delay = remaining > 0 ? Math.min(3150, remaining + 150) : 1000;
            growthRecheckTimer = window.setTimeout(() => {
                growthRecheckTimer = 0;
                refreshDisplaySafely();
            }, delay);
        };

        const maintainParking = () => {
            if (!displayEnabled) return;
            repairDisplay();
            const scrollRoot = ensureDisplayScrollRoot();
            if (!(scrollRoot instanceof Element)) return;
            const assistants = getAssistantTurns();
            const latest = assistants[assistants.length - 1];
            const rootRect = scrollRoot.getBoundingClientRect();
            if (autoRestoreParked) {
                for (const [turn, entry] of Array.from(parkedTurns.entries())) {
                    const rect = entry.placeholder.getBoundingClientRect();
                    if (rect.bottom > rootRect.top - scrollRoot.clientHeight && rect.top < rootRect.bottom + scrollRoot.clientHeight) {
                        unparkTurn(turn);
                    }
                }
            }
            if (!shouldParkOldAnswers()) return;
            const atBottom = scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 80;
            const margin = atBottom ? 0 : Math.max(400, scrollRoot.clientHeight * 1.5);
            for (const turn of assistants) {
                if (turn === latest || turn === shieldState?.turn || parkedTurns.has(turn)) continue;
                const rect = turn.getBoundingClientRect();
                if (rect.bottom < rootRect.top - margin || rect.top > rootRect.bottom + margin) parkTurn(turn);
            }
        };

        /** @param {boolean} on @param {boolean} persist */
        const setDisplayEnabled = (on, persist = true) => {
            if (persist) {
                layers.display = on;
                saveLayerState();
            }
            const active = on && totalEnabled && isChatGptHost() && !testDisplayDisabled;
            if (!active) {
                displayEnabled = false;
                exitFocusMode();
                unshieldTurn();
                restoreAllParked();
                for (const turn of document.querySelectorAll('[data-lcl-manual]')) {
                    if (turn instanceof HTMLElement) delete turn.dataset.lclManual;
                }
                displayObserver?.disconnect();
                displayObserver = null;
                displayObservedMain = null;
                displayScrollRoot = null;
                displayHealthMisses = 0;
                window.clearInterval(displayInterval);
                displayInterval = 0;
                window.clearTimeout(growthRecheckTimer);
                growthRecheckTimer = 0;
                updateUi();
                return;
            }
            if (!hasAssistantTurns()) {
                displayEnabled = false;
                if (status) status.textContent = '当前对话还没有可优化的助手回答；不修改消息。';
                updateUi();
                return;
            }
            displayEnabled = true;
            ensureDisplayScrollRoot();
            if (!displayObserver) {
                const main = document.querySelector('main') ?? document.body;
                displayObserver = new NativeMutationObserver(() => scheduleDisplay(350));
                displayObserver.observe(main, {childList: true, subtree: true});
                displayObservedMain = main;
            }
            if (!displayInterval) displayInterval = window.setInterval(refreshDisplaySafely, 1500);
            refreshDisplay();
            updateUi();
        };

        // React 切换会话或替换回答时可能短暂移除脚本创建的节点；失败时先释放旧状态，避免后续重试叠加观察器。
        const resetDisplayRuntime = () => {
            window.clearTimeout(displayScrollTimer);
            displayScrollTimer = 0;
            window.clearTimeout(growthRecheckTimer);
            growthRecheckTimer = 0;
            window.clearTimeout(displayHealthCheckTimer);
            displayHealthCheckTimer = 0;
            window.clearInterval(displayInterval);
            displayInterval = 0;
            displayObserver?.disconnect();
            displayObserver = null;
            displayObservedMain = null;
            displayScrollRoot = null;
            displayHealthMisses = 0;
            exitFocusMode();
            unshieldTurn();
            restoreAllParked();
            displayEnabled = false;
        };

        const refreshDisplaySafely = () => {
            if (displayEnabled && performance.now() < inputBusyUntil) return;
            try {
                refreshDisplay();
            } catch (error) {
                displayActivationAttempts += 1;
                displayActivationError = error instanceof Error ? error.message : String(error);
                resetDisplayRuntime();
                displayNextAttemptAt = performance.now()
                    + Math.min(8000, 500 * (2 ** Math.min(displayActivationAttempts - 1, 4)));
                console.warn('[ChatGPT 长对话流畅] 轻量显示刷新失败，将稍后重试', {
                    attempt: displayActivationAttempts,
                    error: displayActivationError
                });
            }
        };

        const activateDisplay = () => {
            displayActivationAttempts += 1;
            try {
                setDisplayEnabled(layers.display, false);
                const assistants = getAssistantTurns();
                const latest = assistants[assistants.length - 1];
                if (!displayEnabled) throw new Error('轻量显示未进入启用状态');
                if (latest && !isLatestGenerating(latest) && !hasUncloneableContent(latest)
                    && !isEditingInside(latest) && !document.querySelector('[data-lcl-twin]')) {
                    throw new Error('最新助手回答静态副本未建立');
                }
                displayActivationAttempts = 0;
                displayActivationError = '';
                displayNextAttemptAt = 0;
                return true;
            } catch (error) {
                displayActivationError = error instanceof Error ? error.message : String(error);
                resetDisplayRuntime();
                displayNextAttemptAt = performance.now()
                    + Math.min(8000, 500 * (2 ** Math.min(displayActivationAttempts - 1, 4)));
                console.warn('[ChatGPT 长对话流畅] 轻量显示初始化失败，将稍后重试', {
                    attempt: displayActivationAttempts,
                    error: displayActivationError
                });
                if (testUiEnabled && diagnosticStatus) diagnosticStatus.textContent = '轻量显示初始化失败：'
                    + (error instanceof Error ? error.message : String(error));
                return false;
            }
        };

        // 统一处理启动和生命周期恢复，避免多个定时器各自判断并重复克隆回答。
        const checkDisplayActivation = () => {
            if (displayEnabled || !totalEnabled || !layers.display || testDisplayDisabled) return;
            if (performance.now() < displayNextAttemptAt) return;
            const assistants = getAssistantTurns();
            if (!assistants.length) {
                displayCandidateSize = 0;
                displayStableChecks = 0;
                return;
            }
            const latest = assistants[assistants.length - 1];
            if (isLatestGenerating(latest)) {
                displayCandidateSize = 0;
                displayStableChecks = 0;
                return;
            }
            const size = latest.querySelectorAll('*').length + (latest.textContent?.length ?? 0);
            if (size === displayCandidateSize) displayStableChecks += 1;
            else {
                displayCandidateSize = size;
                displayStableChecks = 0;
            }
            if (displayStableChecks >= 1) activateDisplay();
        };

        // 页面从后台恢复、主区域被 React 替换或显示副本被移除时，低频校正显示层状态。
        const reconcileDisplayHealth = () => {
            if (testDisplayDisabled || !totalEnabled || !layers.display || !isChatGptHost()) return;
            const assistants = getAssistantTurns();
            if (!assistants.length) {
                displayHealthMisses = 0;
                return;
            }
            const latest = assistants[assistants.length - 1];
            // 专注模式退出与观察器修复不依赖生成状态，先生效，避免生成期被整体跳过。
            if (focusModeTurn && (!focusModeTurn.isConnected || focusTurnOf(document.activeElement) !== focusModeTurn)) {
                exitFocusMode();
            }
            const observedRoot = document.querySelector('main') ?? document.body;
            const observedHealthy = Boolean(displayObserver && displayObservedMain === observedRoot
                && displayObservedMain?.isConnected);
            if (displayEnabled && !observedHealthy) {
                displayObserver?.disconnect();
                displayObserver = new NativeMutationObserver(() => scheduleDisplay(350));
                displayObserver.observe(observedRoot, {childList: true, subtree: true});
                displayObservedMain = observedRoot;
                displayScrollRoot = null;
                ensureDisplayScrollRoot();
            }
            if (isLatestGenerating(latest)) {
                displayHealthMisses = 0;
                return;
            }
            const stateful = hasUncloneableContent(latest) || isEditingInside(latest);
            const cloneVisible = Boolean(shieldState && shieldState.clone.style.getPropertyValue('display') !== 'none');
            const cloneHealthy = Boolean(displayEnabled && shieldState
                && shieldState.turn === latest && shieldState.turn.isConnected
                && shieldState.clone.isConnected && latest.dataset.lclShielded === '1'
                && (cloneVisible || focusHiddenTwin === shieldState.clone));
            const interactiveHealthy = Boolean(displayEnabled && stateful && !shieldState);
            if (cloneHealthy || interactiveHealthy) {
                displayHealthMisses = 0;
                return;
            }
            displayHealthMisses += 1;
            if (displayHealthMisses < 2) return;
            displayHealthMisses = 0;
            displayActivationAttempts = 0;
            displayActivationError = '';
            // 非破坏式修复：只补建最新回答的副本，
            // 不 restoreAllParked()——那会在任意 5 秒边界把上万个节点的回答整层恢复，造成可感知的卡顿。
            if (!stateful && canShieldNow(latest)) {
                unshieldTurn();
                shieldTurn(latest);
            }
            displayCandidateSize = 0;
            displayStableChecks = 0;
            if (!displayEnabled) checkDisplayActivation();
            else refreshDisplay();
        };

        const scheduleDisplayHealthCheck = () => {
            if (testDisplayDisabled || displayHealthCheckTimer) return;
            displayHealthCheckTimer = window.setTimeout(() => {
                displayHealthCheckTimer = 0;
                reconcileDisplayHealth();
            }, 400);
        };

        const onDisplayScroll = () => {
            if (!displayEnabled) return;
            displayScrollingUntil = performance.now() + 300;
            window.clearTimeout(displayScrollTimer);
            displayScrollTimer = window.setTimeout(() => { displayScrollTimer = 0; maintainParking(); }, 350);
        };
        document.addEventListener('focusin', (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            if (!isEditableElement(target)) return;
            const turn = target.closest(messageSelector);
            if (!(turn instanceof HTMLElement)) return;
            // 只对「助手回答」生效：用户消息里点「编辑」也会出现输入框，
            // 那时若把全部助手回答收起来会非常突兀。
            if (!getAssistantTurns().some((assistant) => assistant === turn
                || assistant.contains(turn) || turn.contains(assistant))) return;
            if (!displayEnabled || !totalEnabled || !layers.display || testDisplayDisabled) return;
            window.clearTimeout(focusRestoreTimer);
            focusRestoreTimer = 0;
            enterFocusMode(turn);
        }, true);
        document.addEventListener('focusout', () => {
            scheduleFocusExit();
        }, true);

        window.addEventListener('scroll', onDisplayScroll, {capture: true, passive: true});

        // ---- 0.6.6 使用反馈提示 -------------------------------------------------
        // 全部判断与计数都在本地完成，不发任何网络请求；存储不可用时整个提示层静默。

        /**
         * @typedef {{firstSeenAt: number, activeMs: number, opens: number, days: string[],
         *     shown: number, lastShownAt: number, optOut: boolean, lastVersion: string}} FeedbackState
         */

        /** @type {FeedbackState | null} */
        let feedbackState = null;
        let feedbackStorageWritable = false;
        let feedbackActiveSince = 0;
        let feedbackLastPersist = 0;
        let feedbackTimer = 0;
        let feedbackHostShown = false;
        let feedbackDismissed = false;

        /** @returns {FeedbackState} */
        const createFeedbackState = () => ({
            firstSeenAt: Date.now(),
            activeMs: 0,
            opens: 0,
            days: [],
            shown: 0,
            lastShownAt: 0,
            optOut: false,
            lastVersion: ''
        });

        /** @param {Date} date @returns {string} */
        const toFeedbackDayKey = (date) => {
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return date.getFullYear() + '-' + month + '-' + day;
        };

        /** @param {unknown} value @returns {value is Record<string, unknown>} */
        const isFeedbackRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

        /** 读取使用计数；存储不可用时返回 null（调用方据此关闭提示层）。 */
        const loadFeedbackState = () => {
            try {
                const raw = localStorage.getItem(feedbackStorageKey);
                feedbackStorageWritable = true;
                if (raw === null) return createFeedbackState();
                const parsed = JSON.parse(raw);
                if (!isFeedbackRecord(parsed)) return createFeedbackState();
                const state = createFeedbackState();
                if (typeof parsed.firstSeenAt === 'number' && Number.isFinite(parsed.firstSeenAt) && parsed.firstSeenAt > 0) {
                    state.firstSeenAt = parsed.firstSeenAt;
                }
                if (typeof parsed.activeMs === 'number' && Number.isFinite(parsed.activeMs) && parsed.activeMs >= 0) {
                    state.activeMs = parsed.activeMs;
                }
                if (typeof parsed.opens === 'number' && Number.isFinite(parsed.opens) && parsed.opens >= 0) {
                    state.opens = Math.floor(parsed.opens);
                }
                if (Array.isArray(parsed.days)) {
                    state.days = parsed.days
                        .filter((item) => typeof item === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item))
                        .slice(-60);
                }
                if (typeof parsed.shown === 'number' && Number.isFinite(parsed.shown) && parsed.shown >= 0) {
                    state.shown = Math.floor(parsed.shown);
                }
                if (typeof parsed.lastShownAt === 'number' && Number.isFinite(parsed.lastShownAt) && parsed.lastShownAt > 0) {
                    state.lastShownAt = parsed.lastShownAt;
                }
                state.optOut = parsed.optOut === true;
                if (typeof parsed.lastVersion === 'string') state.lastVersion = parsed.lastVersion.slice(0, 24);
                return state;
            } catch {
                feedbackStorageWritable = false;
                return null;
            }
        };

        /** @param {FeedbackState} state @returns {boolean} */
        const saveFeedbackState = (state) => {
            try {
                localStorage.setItem(feedbackStorageKey, JSON.stringify(state));
                feedbackStorageWritable = true;
                return true;
            } catch {
                feedbackStorageWritable = false;
                return false;
            }
        };

        /** 首次进入时登记：打开次数 +1、记录当天日期。重复调用幂等。 */
        const initFeedbackState = () => {
            if (feedbackState) return feedbackState;
            const loaded = loadFeedbackState();
            if (!loaded) return null;
            feedbackState = loaded;
            feedbackState.opens += 1;
            const dayKey = toFeedbackDayKey(new Date());
            if (!feedbackState.days.includes(dayKey)) {
                feedbackState.days.push(dayKey);
                if (feedbackState.days.length > 60) feedbackState.days = feedbackState.days.slice(-60);
            }
            saveFeedbackState(feedbackState);
            return feedbackState;
        };

        const isFeedbackPageVisible = () => document.visibilityState !== 'hidden';

        /**
         * 结算自上次记账以来的可见时长，并重新起算。
         * @param {number} now
         */
        const accumulateFeedbackTime = (now) => {
            if (!feedbackState) return;
            if (feedbackActiveSince > 0 && now > feedbackActiveSince) {
                feedbackState.activeMs += now - feedbackActiveSince;
            }
            feedbackActiveSince = isFeedbackPageVisible() ? now : 0;
        };

        /** @param {boolean} force */
        const persistFeedbackUsage = (force) => {
            if (!feedbackState) return;
            const now = performance.now();
            if (!force && now - feedbackLastPersist < feedbackRules.persistMs) return;
            feedbackLastPersist = now;
            saveFeedbackState(feedbackState);
        };

        /** 提示层是否在当前页面生效：真实 chatgpt.com，或本地回归参数。 */
        const feedbackEnabled = () => isChatGptHost() || feedbackTestEnabled;

        /** @returns {boolean} */
        const shouldShowFeedback = () => {
            if (!feedbackState || feedbackHostShown || feedbackDismissed) return false;
            if (!feedbackEnabled() || !feedbackStorageWritable) return false;
            if (feedbackState.optOut) return false;
            if (feedbackForceTest) return true;
            const now = Date.now();
            if (feedbackState.lastShownAt > 0 && now - feedbackState.lastShownAt < feedbackRules.cooldownMs) return false;
            if (feedbackState.opens < feedbackRules.minOpens) return false;
            const days = new Set(feedbackState.days);
            days.add(toFeedbackDayKey(new Date(now)));
            if (days.size < feedbackRules.minDays) return false;
            return feedbackState.activeMs >= feedbackRules.minActiveMs;
        };

        const dismissFeedback = () => {
            const host = document.getElementById(feedbackHostId);
            const checkbox = host?.shadowRoot?.querySelector('input[type="checkbox"]');
            if (feedbackState) {
                if (checkbox instanceof HTMLInputElement) feedbackState.optOut = checkbox.checked;
                feedbackState.lastShownAt = Date.now();
                feedbackState.lastVersion = version;
                saveFeedbackState(feedbackState);
            }
            feedbackDismissed = true;
            feedbackHostShown = false;
            if (host) host.remove();
        };

        const showFeedbackDialog = () => {
            const state = feedbackState;
            if (!state || feedbackHostShown) return;
            if (document.getElementById(feedbackHostId)) return;
            feedbackHostShown = true;
            state.shown += 1;
            state.lastShownAt = Date.now();
            state.lastVersion = version;
            // 先落盘再插 DOM：写入失败就放弃，避免存储异常时每次刷新都弹。
            if (!saveFeedbackState(state)) {
                feedbackHostShown = false;
                return;
            }
            const host = document.createElement('div');
            host.id = feedbackHostId;
            const shadow = host.attachShadow({mode: 'open'});
            const style = document.createElement('style');
            style.textContent = ':host { position:fixed; top:64px; right:14px; z-index:2147483000;'
                + ' width:min(320px, calc(100vw - 28px)); color-scheme:light dark;'
                + ' font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }\n'
                + '.box { display:flex; flex-direction:column; gap:9px; padding:12px 13px;'
                + ' border:1px solid #7aa7ff; border-radius:10px; background:Canvas; color:CanvasText;'
                + ' box-shadow:0 4px 18px #0003; }\n'
                + '.head { display:flex; align-items:flex-start; gap:8px; }\n'
                + '.head strong { flex:1; font-size:13px; line-height:1.4; }\n'
                + '.close { flex:none; padding:0 4px; border:0; background:transparent; color:inherit;'
                + ' font:inherit; font-size:16px; line-height:1; cursor:pointer; opacity:.65; }\n'
                + '.close:hover { opacity:1; }\n'
                + '.body { margin:0; opacity:.85; }\n'
                + '.links { display:flex; flex-wrap:wrap; gap:6px; }\n'
                + '.link { flex:1 1 120px; padding:6px 8px; border:1px solid #7aa7ff; border-radius:6px;'
                + ' text-align:center; text-decoration:none; color:CanvasText; background:transparent; }\n'
                + '.link.primary { border-color:transparent; background:#3b82f6; color:#fff; }\n'
                + '.link:hover { filter:brightness(1.06); }\n'
                + '.opt { display:flex; align-items:flex-start; gap:6px; opacity:.85; cursor:pointer; }\n'
                + '.opt input { margin:2px 0 0; }\n'
                + '.foot { opacity:.5; font-size:11px; }\n'
                + '@media (max-width:480px) { :host { left:8px; right:8px; width:auto; top:56px; } }\n'
                + '@media print { :host { display:none; } }';

            const box = document.createElement('div');
            box.className = 'box';
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-label', '使用反馈');

            const head = document.createElement('div');
            head.className = 'head';
            const title = document.createElement('strong');
            title.textContent = '用了一段时间，给点反馈？';
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'close';
            close.setAttribute('aria-label', '关闭反馈窗口');
            close.textContent = '×';
            head.append(title, close);

            const body = document.createElement('p');
            body.className = 'body';
            body.textContent = '如果它让长对话顺了一点，或者你还卡在什么地方，欢迎留一句反馈。';

            const links = document.createElement('div');
            links.className = 'links';
            const greasyforkLink = document.createElement('a');
            greasyforkLink.className = 'link primary';
            greasyforkLink.href = feedbackLinks.greasyfork;
            greasyforkLink.target = '_blank';
            greasyforkLink.rel = 'noopener noreferrer';
            greasyforkLink.textContent = 'Greasy Fork 反馈';
            const githubLink = document.createElement('a');
            githubLink.className = 'link';
            githubLink.href = feedbackLinks.github;
            githubLink.target = '_blank';
            githubLink.rel = 'noopener noreferrer';
            githubLink.textContent = 'GitHub 提 Issue';
            links.append(greasyforkLink, githubLink);

            const option = document.createElement('label');
            option.className = 'opt';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = state.optOut;
            const optionText = document.createElement('span');
            optionText.textContent = '不再弹出（脚本更新后也不再提示）';
            option.append(checkbox, optionText);

            const foot = document.createElement('div');
            foot.className = 'foot';
            foot.textContent = 'v' + version;

            // 勾选即落盘：避免用户勾完直接关标签页，导致「不再弹出」没被记住。
            checkbox.addEventListener('change', () => {
                if (!feedbackState) return;
                feedbackState.optOut = checkbox.checked;
                saveFeedbackState(feedbackState);
            });
            close.addEventListener('click', dismissFeedback);
            box.addEventListener('keydown', (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                dismissFeedback();
            });

            box.append(head, body, links, option, foot);
            shadow.append(style, box);
            (document.body || document.documentElement).append(host);
        };

        const maybeShowFeedback = () => {
            if (!feedbackState || !feedbackEnabled()) return;
            accumulateFeedbackTime(performance.now());
            if (!shouldShowFeedback()) return;
            // 多个标签可能同时到达阈值：展示前重读一次，10 秒内已展示过就放弃。
            const latest = loadFeedbackState();
            if (latest && latest.lastShownAt > 0
                && Date.now() - latest.lastShownAt < feedbackRules.duplicateWindowMs) {
                return;
            }
            showFeedbackDialog();
        };

        const feedbackTick = () => {
            if (!feedbackState) return;
            accumulateFeedbackTime(performance.now());
            persistFeedbackUsage(false);
            maybeShowFeedback();
        };

        const handleFeedbackVisibility = () => {
            if (!feedbackState) return;
            accumulateFeedbackTime(performance.now());
            if (isFeedbackPageVisible()) maybeShowFeedback();
            else persistFeedbackUsage(true);
        };

        const handleFeedbackPageHide = () => {
            if (!feedbackState) return;
            accumulateFeedbackTime(performance.now());
            persistFeedbackUsage(true);
        };

        const startUi = () => {
            if (uiStarted || document.getElementById(panelId)) return;
            uiStarted = true;
            if (testUiEnabled) {
            panel = document.createElement('div');
            panel.id = panelId;
            shadow = panel.attachShadow({mode: 'open'});
            const uiStyle = document.createElement('style');
            uiStyle.textContent = panelStyle;
            const details = document.createElement('details');
            summary = document.createElement('summary');
            summary.textContent = '长对话优化';
            section = document.createElement('section');
            toggleButton = document.createElement('button');
            toggleButton.type = 'button';
            status = document.createElement('p');
            status.setAttribute('role', 'status');
            diagnoseButton = document.createElement('button');
            diagnoseButton.type = 'button';
            diagnoseButton.textContent = '记录 20 秒性能';
            downloadButton = document.createElement('button');
            downloadButton.type = 'button';
            downloadButton.textContent = '下载诊断结果';
            downloadButton.disabled = true;
            focusButton = document.createElement('button');
            focusButton.type = 'button';
            focusButton.textContent = '输入优先：临时收起回答';
            focusDescription = document.createElement('p');
            focusDescription.textContent = '默认关闭；只在输入或操作菜单时临时收起回答。';
            damperButton = document.createElement('button');
            damperButton.type = 'button';
            contentButton = document.createElement('button');
            contentButton.type = 'button';
            copyButton = document.createElement('button');
            copyButton.type = 'button';
            copyButton.textContent = '复制诊断摘要';
            copyButton.disabled = true;
            displayButton = document.createElement('button');
            displayButton.type = 'button';
            displayButton.textContent = '轻量显示：开';
            layerStatus = document.createElement('p');
            diagnosticStatus = document.createElement('p');
            diagnosticStatus.textContent = '仅记录耗时和数量，不记录输入文字。';
            section.append(toggleButton, status, diagnoseButton, downloadButton, focusButton, focusDescription,
                damperButton, contentButton, copyButton, displayButton, layerStatus, diagnosticStatus);
            details.append(summary, section);
            shadow.append(uiStyle, details);
            document.body.append(panel);

            toggleButton.addEventListener('click', () => setTotalEnabled(!totalEnabled));
            damperButton.addEventListener('click', () => setDamper(!layers.damper));
            contentButton.addEventListener('click', () => setContentVisibility(!layers.contentVisibility));
            focusButton.addEventListener('click', () => setFocusEnabled(!focusEnabled));
            displayButton.addEventListener('click', () => setDisplayEnabled(!layers.display));
            }

            // 不拦截浏览器查找快捷键；先恢复回答，再让原来的 Ctrl+F 或打印操作继续。
            document.addEventListener('keydown', (event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
                    if (focusEnabled) setFocusEnabled(false, true);
                    if (displayEnabled) restoreForSearch();
                }
            }, true);
            window.addEventListener('beforeprint', () => {
                // 打印期间即使正在诊断也恢复全文；该轮诊断将标记模式变化。
                if (focusEnabled) setFocusEnabled(false, true);
                if (displayEnabled) restoreForSearch();
            });

            if (testUiEnabled) {
            // 诊断仅按需运行 20 秒，数据不含正文、按键内容、消息标识或网址。
            diagnoseButton.addEventListener('click', () => {
                if (recording || typeof PerformanceObserver === 'undefined') return;
                recording = true;
                const disableButtons = [toggleButton, diagnoseButton, downloadButton, focusButton, damperButton, contentButton, copyButton, displayButton];
                for (const button of disableButtons) button.disabled = true;
                diagnosticStatus.textContent = '记录中：请正常输入、删除或点击，不必发送消息。';
                const started = performance.now();
                const startFocusEnabled = focusEnabled;
                const startLayerSnapshot = JSON.stringify({totalEnabled, layers: {...layers}, focusEnabled});
                const startNodes = document.querySelectorAll('*').length;
                const memory = /** @type {Performance & {memory?: {usedJSHeapSize: number}}} */ (performance);
                const startHeap = memory.memory?.usedJSHeapSize ?? null;
                /** @type {number|null} */
                let heapMinimum = startHeap;
                /** @type {number|null} */
                let heapPeak = startHeap;
                let heapSampleCount = 0;
                const sampleHeap = () => {
                    const value = memory.memory?.usedJSHeapSize ?? null;
                    if (value === null) return;
                    heapSampleCount += 1;
                    if (heapMinimum === null || value < heapMinimum) heapMinimum = value;
                    if (heapPeak === null || value > heapPeak) heapPeak = value;
                };
                sampleHeap();
                const heapSampleTimer = window.setInterval(sampleHeap, 500);
                let backgrounded = document.hidden;
                /** @type {Array<{type: string, durationMs: number, inputDelayMs: number, processingMs: number}>} */
                const slowEvents = [];
                /** @type {number[]} */
                const longTasks = [];
                /** @type {Array<{type: string, ms: number}>} */
                const nextFrameSamples = [];
                /** @type {Array<any>} */
                const longAnimationFrames = [];
                /** @type {PerformanceObserver[]} */
                const diagnosticObservers = [];
                /** @type {Record<string, number>} */
                const eventCounts = {};
                /** @param {Event} event */
                const countEvent = (event) => { eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1; };
                const watchVisibility = () => { backgrounded ||= document.hidden; };
                /** @param {Event} event */
                const sampleNextFrame = (event) => {
                    if (event.target instanceof Element && event.target.closest('#' + panelId)) return;
                    const type = event.type;
                    const startedAt = performance.now();
                    window.requestAnimationFrame(() => {
                        if (!recording) return;
                        if (nextFrameSamples.length < 3000) {
                            nextFrameSamples.push({type, ms: Math.round((performance.now() - startedAt) * 10) / 10});
                        }
                    });
                };
                const countedTypes = ['keydown', 'input', 'click', 'pointerover', 'compositionend'];
                for (const type of countedTypes) document.addEventListener(type, countEvent, {capture: true, passive: true});
                for (const type of ['keydown', 'input', 'click', 'pointerdown']) {
                    document.addEventListener(type, sampleNextFrame, {capture: true, passive: true});
                }
                document.addEventListener('visibilitychange', watchVisibility);
                /** @param {PerformanceEntry[]} entries */
                const collectEntries = (entries) => {
                    for (const entry of entries) {
                        if (entry.startTime < started) continue;
                        if (entry.entryType === 'longtask' && longTasks.length < 500) longTasks.push(entry.duration);
                        if (entry.entryType === 'event' && slowEvents.length < 2000) {
                            const timing = /** @type {PerformanceEntry & {processingStart: number, processingEnd: number}} */ (entry);
                            slowEvents.push({type: entry.name, durationMs: entry.duration,
                                inputDelayMs: Math.max(0, timing.processingStart - entry.startTime),
                                processingMs: Math.max(0, timing.processingEnd - timing.processingStart)});
                        }
                    }
                };
                for (const type of ['event', 'longtask']) {
                    if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
                    const diagnosticObserver = new PerformanceObserver((list) => collectEntries(list.getEntries()));
                    diagnosticObserver.observe({type, buffered: false, ...(type === 'event' ? {durationThreshold: 16} : {})});
                    diagnosticObservers.push(diagnosticObserver);
                }
                if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
                    const loafObserver = new PerformanceObserver((list) => {
                        for (const entry of list.getEntries()) {
                            if (entry.startTime < started || longAnimationFrames.length >= 500) continue;
                            const loaf = /** @type {any} */ (entry);
                            longAnimationFrames.push({
                                durationMs: loaf.duration,
                                blockingDurationMs: loaf.blockingDuration,
                                styleAndLayoutDurationMs: loaf.styleAndLayoutDuration,
                                renderStartMs: loaf.renderStart,
                                scripts: Array.isArray(loaf.scripts)
                                    ? loaf.scripts.slice(0, 5).map(/** @param {any} script */ (script) => ({
                                        source: typeof script.sourceURL === 'string' ? script.sourceURL.split('/').pop() : null,
                                        durationMs: script.duration,
                                        invoker: script.invoker
                                    }))
                                    : []
                            });
                        }
                    });
                    loafObserver.observe({type: 'long-animation-frame', buffered: false});
                    diagnosticObservers.push(loafObserver);
                }
                const finishRecording = () => {
                    window.clearInterval(heapSampleTimer);
                    sampleHeap();
                    for (const diagnosticObserver of diagnosticObservers) {
                        collectEntries(diagnosticObserver.takeRecords());
                        diagnosticObserver.disconnect();
                    }
                    for (const type of countedTypes) document.removeEventListener(type, countEvent, true);
                    for (const type of ['keydown', 'input', 'click', 'pointerdown']) {
                        document.removeEventListener(type, sampleNextFrame, true);
                    }
                    document.removeEventListener('visibilitychange', watchVisibility);
                    const durations = slowEvents.map((event) => event.durationMs).sort((a, b) => a - b);
                    const nextFrameValues = nextFrameSamples.map((sample) => sample.ms).sort((a, b) => a - b);
                    /** @param {number[]} values @returns {number | null} */
                    const p95 = (values) => values.length ? values[Math.ceil(values.length * 0.95) - 1] : null;
                    const report = {
                        version,
                        optimizationEnabled: totalEnabled,
                        focusModeEnabled: startFocusEnabled,
                        modeChangedDuringRecording: startLayerSnapshot !== JSON.stringify({totalEnabled, layers: {...layers}, focusEnabled}),
                        layers: {damper: layers.damper, composer: layers.composer, contentVisibility: layers.contentVisibility,
                            display: layers.display, total: totalEnabled, focus: focusEnabled},
                        display: {enabled: displayEnabled, parked: parkedTurns.size, shielded: Boolean(shieldState)},
                        elapsedMs: Math.round(performance.now() - started),
                        backgrounded,
                        messageContainers: messageCount,
                        optimizedContainers: marked.size,
                        thread: getThreadStats(),
                        observerStats: getDamperSnapshot(),
                        domElementsAtStart: startNodes,
                        domElementsAtEnd: document.querySelectorAll('*').length,
                        jsHeapBytesAtStart: startHeap,
                        jsHeapBytesAtEnd: memory.memory?.usedJSHeapSize ?? null,
                        jsHeapBytesMinimum: heapMinimum,
                        jsHeapBytesPeak: heapPeak,
                        jsHeapSampleCount: heapSampleCount,
                        jsHeapGrowthBytes: startHeap !== null && heapPeak !== null ? heapPeak - startHeap : null,
                        supportedEntryTypes: PerformanceObserver.supportedEntryTypes,
                        eventCounts,
                        slowEventThresholdMs: 16,
                        recordedSlowEventP95Ms: p95(durations),
                        slowEvents,
                        longTaskCount: longTasks.length,
                        longTaskTotalMs: longTasks.reduce((a, b) => a + b, 0),
                        longTaskMaxMs: longTasks.length ? Math.max(...longTasks) : null,
                        longTasks,
                        longAnimationFrames,
                        nextFrameSamples,
                        nextFrameCount: nextFrameSamples.length,
                        nextFrameP50Ms: nextFrameValues.length ? nextFrameValues[Math.ceil(nextFrameValues.length * 0.5) - 1] : null,
                        nextFrameP95Ms: p95(nextFrameValues),
                        nextFrameMaxMs: nextFrameValues.length ? nextFrameValues[nextFrameValues.length - 1] : null,
                        note: 'slowEvents 的 P95 仅针对浏览器上报的慢事件；nextFrame 是事件到下一帧的代理，不是正式 INP。'
                    };
                    reportText = JSON.stringify(report, null, 2);
                    reportEnabled = totalEnabled;
                    reportFocusEnabled = startFocusEnabled;
                    reportLayers = {...layers};
                    recording = false;
                    for (const button of disableButtons) button.disabled = false;
                    downloadButton.disabled = false;
                    copyButton.disabled = false;
                    diagnosticStatus.textContent = '记录完成：' + slowEvents.length + ' 个慢事件，'
                        + longTasks.length + ' 个长任务。可下载结果。';
                };
                window.setTimeout(finishRecording, 20000);
            });

            // 结果只在用户点击时下载到本机，不发起网络请求。
            downloadButton.addEventListener('click', () => {
                if (!reportText) return;
                const objectUrl = URL.createObjectURL(new Blob([reportText], {type: 'application/json;charset=utf-8'}));
                const anchor = document.createElement('a');
                anchor.href = objectUrl;
                anchor.download = 'ChatGPT长对话诊断-'
                    + (reportFocusEnabled ? '专注' : reportEnabled ? '开启' : '关闭') + '-' + Date.now() + '.json';
                anchor.click();
                window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
            });

            copyButton.addEventListener('click', async () => {
                if (!reportText) return;
                try {
                    await navigator.clipboard.writeText(reportText);
                    diagnosticStatus.textContent = '诊断摘要已复制到剪贴板。';
                } catch {
                    const helper = document.createElement('textarea');
                    helper.value = reportText;
                    helper.style.position = 'fixed';
                    helper.style.opacity = '0';
                    document.body.append(helper);
                    helper.select();
                    document.execCommand('copy');
                    helper.remove();
                    diagnosticStatus.textContent = '诊断摘要已复制到剪贴板。';
                }
            });
            }

            const supportsContentVisibility = CSS.supports('content-visibility', 'auto')
                && CSS.supports('contain-intrinsic-block-size', 'auto 600px');
            if (!supportsContentVisibility) {
                layers.contentVisibility = false;
                if (testUiEnabled) {
                    contentButton.disabled = true;
                    contentButton.textContent = '历史消息轻量：浏览器不支持';
                }
            } else {
                setContentVisibility(layers.contentVisibility, false);
            }
            setDamper(layers.damper, false);
            // 默认启用：不再要求长对话规模；等最新回答稳定后自动建立静态副本。
            if (!displayActivationTimer) {
                displayActivationTimer = window.setInterval(checkDisplayActivation, 1500);
            }
            if (!displayHealthTimer) {
                displayHealthTimer = window.setInterval(reconcileDisplayHealth, 5000);
                window.addEventListener('pageshow', scheduleDisplayHealthCheck);
                window.addEventListener('focus', scheduleDisplayHealthCheck);
                window.addEventListener('resume', scheduleDisplayHealthCheck);
                document.addEventListener('visibilitychange', scheduleDisplayHealthCheck);
            }
            // 正常页面不出现成功提示；只有多次捕获初始化异常且仍未启用时才提示。
            window.setTimeout(() => {
                if (testDisplayDisabled || !totalEnabled || !layers.display || displayEnabled) return;
                // 只有实际执行过多次初始化且捕获到异常时才提示；避免把 React 延迟渲染误报为页面结构失配。
                if (displayActivationAttempts < 3 || !displayActivationError) return;
                const assistants = getAssistantTurns();
                if (!assistants.length) return;
                const latest = assistants[assistants.length - 1];
                if (!isLatestGenerating(latest)) {
                    showFaultNotice('长对话优化连续初始化失败：页面结构可能已更新。可在篡改猴中停用本脚本。');
                }
            }, 12000);
            updateUi();
            // 0.6.6：使用一段时间后给一次反馈提示；只做本地计数，不发网络请求。
            if (!feedbackTimer) {
                initFeedbackState();
                if (feedbackState) {
                    feedbackActiveSince = isFeedbackPageVisible() ? performance.now() : 0;
                    feedbackTimer = window.setInterval(feedbackTick, feedbackRules.tickMs);
                    document.addEventListener('visibilitychange', handleFeedbackVisibility);
                    window.addEventListener('pagehide', handleFeedbackPageHide);
                    window.setTimeout(maybeShowFeedback, feedbackRules.checkDelayMs);
                }
            }
        };

        const boot = () => {
            try {
                startUi();
            } catch (error) {
                console.warn('[ChatGPT 长对话轻量] 初始化失败', error);
                showFaultNotice('长对话优化初始化失败，页面结构可能已更新。可在篡改猴中停用本脚本。');
            }
        };

        if (document.body) boot();
        else document.addEventListener('DOMContentLoaded', boot, {once: true});

    }
}
