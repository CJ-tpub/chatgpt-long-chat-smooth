// ==UserScript==
// @name         ChatGPT 长对话流畅优化
// @name:en      ChatGPT Long Chat Smooth
// @namespace    https://github.com/CJ-tpub/chatgpt-long-chat-smooth
// @version      0.4.1
// @description  Reduce interaction lag in long ChatGPT conversations: typing, clicking and scrolling feel smoother with less jank.
// @description:zh-CN 减少 ChatGPT 长对话/长会话的输入、点击和滚动交互卡顿，让操作更顺滑。
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
        const version = '0.4.1';
        const panelId = 'cgpt-long-chat-lite-panel';
        const noticeId = 'cgpt-long-chat-lite-notice';
        const testUiEnabled = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
        const testDisplayDisabled = testUiEnabled && new URLSearchParams(location.search).has('cgpt-lcl-no-display');
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
                    value: {getDamperSnapshot, showFaultNotice}
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
        // 只在真实 ChatGPT 长会话启用；本地夹具不会触发。
        /** @type {{turn: HTMLElement, clone: HTMLElement, signature: number, turnHeight: number, displayValue: string, displayPriority: string} | null} */
        let shieldState = null;
        /** @type {Map<HTMLElement, {placeholder: HTMLElement, observer: IntersectionObserver | null, displayValue: string, displayPriority: string}>} */
        const parkedTurns = new Map();
        /** @type {Element | null} */
        let displayScrollRoot = null;
        /** @type {MutationObserver | null} */
        let displayObserver = null;
        let displayInterval = 0;
        let displayScrollTimer = 0;
        let displayEnabled = false;
        let displayPausedUntil = 0;
        let displayActivationTimer = 0;
        let displayCandidateSize = 0;
        let displayStableChecks = 0;
        let autoRestoreParked = true;
        let displayScrollingUntil = 0;
        const displayCounters = {shield: 0, unshield: 0, park: 0, unpark: 0, refresh: 0, reattach: 0};

        const isChatGptHost = () => location.hostname === 'chatgpt.com' || location.hostname.endsWith('.chatgpt.com');

        const getAssistantTurns = () => findTurns().filter((turn) => turn.matches('[data-chatgpt-search-unit-key$=":assistant"], [data-message-author-role="assistant"]')
            || Boolean(turn.querySelector('[data-message-author-role="assistant"]')));

        const hasAssistantTurns = () => isChatGptHost() && getAssistantTurns().length > 0;

        // 最新回答始终使用静态副本；旧回答只在确实会拖慢页面的多回答会话里收起。
        const shouldParkOldAnswers = () => {
            const assistants = getAssistantTurns();
            if (assistants.length < 2) return false;
            const main = document.querySelector('main');
            const twin = main?.querySelector('[data-lcl-twin]');
            const twinNodes = twin ? twin.querySelectorAll('*').length + 1 : 0;
            const total = main ? main.querySelectorAll('*').length - twinNodes : 0;
            const old = assistants.slice(0, -1);
            const largestOld = old.reduce((max, turn) => Math.max(max, turn.querySelectorAll('*').length), 0);
            return total >= 5000 || largestOld >= 1500;
        };

        /** @param {HTMLElement} turn */
        const isStreamingTurn = (turn) => turn.getAttribute('aria-busy') === 'true'
            || Boolean(turn.querySelector('[data-result-streaming], [data-message-streaming], [data-streaming="true"], .result-streaming, .streaming'));

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

        /** @param {HTMLElement} turn */
        const shieldTurn = (turn) => {
            if (!turn.isConnected) return;
            if (shieldState?.turn === turn && shieldState.clone.isConnected) return;
            unshieldTurn();
            const parent = turn.parentElement;
            if (!parent) return;
            const displayValue = turn.style.getPropertyValue('display');
            const displayPriority = turn.style.getPropertyPriority('display');
            const turnHeight = turn.getBoundingClientRect().height;
            const signature = turn.textContent?.length ?? 0;
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
            parent.insertBefore(clone, turn.nextSibling);
            turn.style.setProperty('display', 'none', 'important');
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
            clone.addEventListener('click', (event) => {
                const target = event.target instanceof Element
                    ? event.target.closest('a, button, [role="button"], summary')
                    : null;
                if (!(target instanceof HTMLElement)) return;
                if (target.tagName === 'A') {
                    const href = target.getAttribute('href');
                    if (href && !href.startsWith('#')) return;
                }
                const path = [];
                /** @type {Element | null} */
                let node = target;
                while (node && node !== clone) {
                    /** @type {Element | null} */
                    const nodeParent = node.parentElement;
                    if (!nodeParent) break;
                    path.unshift(Array.prototype.indexOf.call(nodeParent.children, node));
                    node = nodeParent;
                }
                /** @type {Element | null} */
                let original = shieldState?.turn ?? null;
                for (const position of path) {
                    original = original?.children[position] ?? null;
                    if (!original) break;
                }
                if (original instanceof HTMLElement) {
                    event.preventDefault();
                    event.stopPropagation();
                    original.click();
                }
            }, true);
            shieldState = {turn, clone, signature, turnHeight, displayValue, displayPriority};
            displayCounters.shield += 1;
            updateUi();
        };

        const unshieldTurn = () => {
            if (!shieldState) return;
            const {turn, clone, displayValue, displayPriority} = shieldState;
            shieldState = null;
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
                }, {root: scrollRoot instanceof Element ? scrollRoot : null, rootMargin: '250% 0px'});
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
            if (shieldState && shieldState.turn !== latest) {
                if (!adoptShieldToLatest(latest)) unshieldTurn();
            }
            const scrollRoot = ensureDisplayScrollRoot();
            const atBottom = scrollRoot instanceof Element
                && scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 80;
            if (isStreamingTurn(latest)) {
                unshieldTurn();
                if (atBottom && shouldParkOldAnswers()) for (const turn of assistants) if (turn !== latest) parkTurn(turn);
                return;
            }
            if (!shieldState) shieldTurn(latest);
            if (atBottom && shouldParkOldAnswers()) for (const turn of assistants) if (turn !== latest) parkTurn(turn);
            updateUi();
        };

        /** @param {number} delay */
        const scheduleDisplay = (delay) => {
            window.clearTimeout(displayScrollTimer);
            displayScrollTimer = window.setTimeout(() => { displayScrollTimer = 0; refreshDisplay(); }, delay);
        };

        const maintainParking = () => {
            if (!displayEnabled) return;
            repairDisplay();
            const scrollRoot = ensureDisplayScrollRoot();
            if (!(scrollRoot instanceof Element)) return;
            const assistants = getAssistantTurns();
            const latest = assistants[assistants.length - 1];
            const atBottom = scrollRoot.scrollTop + scrollRoot.clientHeight >= scrollRoot.scrollHeight - 40;
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
            for (const turn of assistants) {
                if (turn === latest || turn === shieldState?.turn || parkedTurns.has(turn)) continue;
                const rect = turn.getBoundingClientRect();
                if (rect.bottom < -scrollRoot.clientHeight * 1.5 || (atBottom && rect.bottom < 0)) parkTurn(turn);
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
                unshieldTurn();
                restoreAllParked();
                for (const turn of document.querySelectorAll('[data-lcl-manual]')) {
                    if (turn instanceof HTMLElement) delete turn.dataset.lclManual;
                }
                displayObserver?.disconnect();
                displayObserver = null;
                window.clearInterval(displayInterval);
                displayInterval = 0;
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
            }
            if (!displayInterval) displayInterval = window.setInterval(refreshDisplay, 1500);
            refreshDisplay();
            updateUi();
        };

        const activateDisplay = () => {
            try {
                setDisplayEnabled(layers.display, false);
            } catch (error) {
                displayEnabled = false;
                console.warn('[ChatGPT 长对话流畅] 轻量显示初始化失败', error);
                showFaultNotice('长对话优化初始化失败，页面结构可能已更新。可在篡改猴中停用本脚本。');
                if (testUiEnabled && diagnosticStatus) diagnosticStatus.textContent = '轻量显示初始化失败：'
                    + (error instanceof Error ? error.message : String(error));
            }
        };

        const onDisplayScroll = () => {
            if (!displayEnabled) return;
            displayScrollingUntil = performance.now() + 300;
            window.clearTimeout(displayScrollTimer);
            displayScrollTimer = window.setTimeout(() => { displayScrollTimer = 0; maintainParking(); }, 350);
        };
        window.addEventListener('scroll', onDisplayScroll, {capture: true, passive: true});

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
                displayActivationTimer = window.setInterval(() => {
                    if (displayEnabled || !totalEnabled || !layers.display || testDisplayDisabled) return;
                    const assistants = getAssistantTurns();
                    if (!assistants.length) {
                        displayCandidateSize = 0;
                        displayStableChecks = 0;
                        return;
                    }
                    const latest = assistants[assistants.length - 1];
                    if (isStreamingTurn(latest)) {
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
                }, 1500);
            }
            // 正常页面不出现成功提示；只有确实有回答但 12 秒仍未启用时才提示。
            window.setTimeout(() => {
                if (testDisplayDisabled || !totalEnabled || !layers.display || displayEnabled) return;
                const assistants = getAssistantTurns();
                if (!assistants.length) return;
                const latest = assistants[assistants.length - 1];
                if (!isStreamingTurn(latest)) {
                    showFaultNotice('长对话优化未生效：页面结构可能已更新。可在篡改猴中停用本脚本。');
                }
            }, 12000);
            updateUi();
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
