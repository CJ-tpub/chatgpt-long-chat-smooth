# ChatGPT 长对话 / 长会话流畅优化（Smooth）

[English](#english)

一个默认开启、无面板的 Tampermonkey 用户脚本，专门优化 **ChatGPT 长对话 / 长会话的交互卡顿**：解决输入迟钝、删除掉帧、菜单点击延迟和滚动卡顿。装好后不需要配置，也不会改变模型上下文或发送内容。

*由 10 月 17 日发布的 DeepSeek V4.1 Flash-1017（deepseekv4.1flash-1017）完成优化；蓝色大肥鱼不只吃白饭了！*

## 它解决什么问题

ChatGPT 聊得越久，页面里的回答越多，下面这些操作会越来越慢：

- 在输入框里打字、删除文字，尤其是中文输入法组合输入时，光标和文字有明显延迟。
- 打开/关闭附件菜单、模型菜单等按钮时，要等一下才响应。
- 从长对话底部向上滚，或者滚回底部露出“ChatGPT 可能会出错”时掉帧。

这不是网络慢，也不是模型回复慢，而是浏览器在反复重排已经很多的消息。脚本的目标是让这些**交互**更顺滑，而不是加速模型。

## 原理（尽量说人话）

ChatGPT 每次输入或点击，都会触发它自己的布局读取和样式失效，让整段回答反复参与样式计算。脚本做了三件事：

1. **旧回答先收起来**：把较早的助手回答在原位置收起，只留一个等高的占位；滚到附近再自动展开，位置和滚动高度不乱。
2. **最新回答用静态副本**：把最新一条已完成的回答做成静态副本，原节点隐藏；副本里的块级内容只渲染看得见的部分。
3. **减少观察器风暴**：合并页面里反复触发的文档级 MutationObserver/ResizeObserver，跳过没有语义变化的重复属性写入。

脚本不拦截 React 事件，不改输入框，不改模型上下文，也不向外部发送数据。

## 优化前后：数据对比

同一台机器、同一个约 2.2 万 DOM 元素的长对话、同一组输入/菜单/滚动操作；数字是受管 Chromium 上的抽测，单位毫秒，越低越好。

![ChatGPT 长对话优化前后交互耗时对比](assets/performance-zh.svg)

| 指标 | 原始 | 优化后 |
| --- | --- | --- |
| 输入 p95 | 376 ms | 160 ms（约 -57%） |
| 菜单点击 p95 | 696 ms | 176 ms（约 -75%） |
| 近底部滚动长任务合计 | 约 1900 ms | 136 ms（约 -93%） |
| 输入/菜单长任务合计 | 7.4～8.0 s | 0.74～1.6 s |

补充说明：

- 首次自动展开一条旧回答，可能出现约 0.35 秒的一次性布局；这是恢复几千个节点的正常成本，不是持续卡顿。
- 真实体验会受浏览器、扩展、CPU 和 ChatGPT 前端版本影响；如果你装了翻译类或其他 ChatGPT 脚本，结果可能不同。
- 这些数字是交互耗时，不是模型回复速度，也不是正式 INP 指标。

## 安装使用

1. 确保浏览器已安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. **[点击这里一键安装用户脚本](https://raw.githubusercontent.com/CJ-tpub/chatgpt-long-chat-smooth/main/chatgpt-long-chat-smooth.user.js)**；也可以在仓库里复制 chatgpt-long-chat-smooth.user.js，手动新建脚本并保存。
3. 刷新一个 ChatGPT 长对话页面即可生效；脚本静默运行，没有常驻面板，也不需要配置。
4. 要停用，在 Tampermonkey 中关闭脚本并刷新页面。

## 兼容与限制

- 正式版没有常驻面板、菜单或关闭按钮；要停用直接在 Tampermonkey 禁用脚本。
- 只在 https://chatgpt.com/* 的长会话启用；普通短对话不会强行修改页面。
- 最新回答是静态副本；如果某条内联控件依赖 React 内部状态，桥接可能失败，停用脚本并刷新即可恢复。
- 回答正在流式生成、重新生成时，脚本会先显示原节点，稳定后再应用；生成过程中看到原始回答是预期行为。
- ChatGPT 前端结构改版可能导致脚本无法识别；此时右下角会出现临时提示，页面保持原样。

## 隐私

脚本不发起网络请求，不上传任何数据；所有收起/恢复和布局处理只发生在当前页面内存中，不收集对话正文、按键内容、消息 ID 或会话 URL。

## 适用场景与关键词

适合：ChatGPT 长对话卡顿、长会话输入延迟、菜单点击不跟手、长对话滚动掉帧，以及希望脚本默认开启、无感运行的用户。

<details>
<summary>搜索关键词 / Keywords</summary>

ChatGPT 长对话交互卡顿优化、ChatGPT 长会话交互卡顿优化、长对话卡顿、长会话卡顿、长对话输入延迟、长会话点击卡顿、长会话滚动卡顿、ChatGPT 流畅、长对话顺滑、长会话优化、Tampermonkey 性能脚本、userscript、ChatGPT smooth、smoother interactions、long ChatGPT conversation lag、long chat interaction performance、smoother long conversations、content-visibility。

</details>

## License

PolyForm Noncommercial 1.0.0，见 LICENSE。允许个人和非商业使用、修改、分发；禁止商业用途。

如需商业授权，请通过 [Issues](https://github.com/CJ-tpub/chatgpt-long-chat-smooth/issues) 联系维护者。

---

## English

A default-on, no-panel Tampermonkey userscript for **long ChatGPT conversations**. It makes typing, deleting, menu clicks and scrolling feel smoother. No setup, no model or context changes.

*Optimized with DeepSeek V4.1 Flash-1017, released on October 17. The big blue fish is no longer just eating plain rice!*

### What it fixes

- **Typing and deleting lag**: noticeable delays when typing (especially with an IME) or deleting text in a long thread.
- **Menu response delay**: attachment or model menus take a moment to respond.
- **Scroll jank**: frame drops when scrolling up from the bottom or revealing the “ChatGPT can make mistakes” footer.

This is caused by the browser repeatedly recalculating layout across thousands of DOM nodes, not by network latency or model speed. The script optimizes **interaction responsiveness**, not model generation speed.

### How it works

1. **Park older answers in place**: older assistant turns are hidden with an equal-height placeholder and restored near the viewport, so page height and scroll position stay stable.
2. **Use a static twin for the latest answer**: the newest completed turn is copied into a static node; the original is hidden and only visible blocks are rendered.
3. **Calm observer storms**: document-level MutationObserver/ResizeObserver callbacks are coalesced, and same-value attribute writes are skipped.

It does not intercept React events, change the composer, alter model context, or send data anywhere.

### Before / after

Same machine, same long conversation with about 22k DOM nodes, same typing/menu/scroll actions. Managed Chromium sample; milliseconds, lower is better.

![ChatGPT long chat interaction latency before and after](assets/performance-en.svg)

| Metric | Before | After |
| --- | --- | --- |
| Input p95 | 376 ms | 160 ms (about -57%) |
| Menu click p95 | 696 ms | 176 ms (about -75%) |
| Near-bottom scroll long tasks | about 1900 ms | 136 ms (about -93%) |
| Input/menu long tasks | 7.4–8.0 s | 0.74–1.6 s |

Notes:

- The first automatic restore of an old answer can cost about 0.35 s of one-time layout; that is the cost of putting thousands of nodes back, not continuous jank.
- Real results vary with browser, extensions, CPU and the ChatGPT frontend version.
- These are interaction timings, not model response speed or official INP.

### Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. **[Install the userscript with one click](https://raw.githubusercontent.com/CJ-tpub/chatgpt-long-chat-smooth/main/chatgpt-long-chat-smooth.user.js)**, or copy chatgpt-long-chat-smooth.user.js into a new Tampermonkey script.
3. Refresh a long ChatGPT conversation. The script runs silently: no panel, no configuration.
4. To stop, disable it in Tampermonkey and refresh the page.

### Limits

- No persistent panel, menu or close button; disable the script in Tampermonkey to stop it.
- Only activates on long conversations on https://chatgpt.com/*.
- The latest answer is a static snapshot. If an inline control depends on React state, the click bridge may fail; disable the script and refresh to recover.
- Streaming or regenerating answers temporarily show the original node; this is expected.
- A ChatGPT frontend change may make the structure unrecognized; a temporary notice appears and the page is left untouched.

### Privacy

No network requests. No analytics or uploads. All parking/restoring and layout work stays in page memory. The script does not collect conversation text, key presses, message IDs or chat URLs.

### Keywords

ChatGPT long conversation interaction lag, ChatGPT long chat performance, smoother long conversations, ChatGPT input latency, ChatGPT click lag, ChatGPT scroll jank, Tampermonkey userscript, long conversation optimization, smooth interactions.

### License

PolyForm Noncommercial 1.0.0. See LICENSE for the full terms. Personal and noncommercial use, modification and distribution are allowed; commercial use is prohibited.

For commercial licensing, please contact the maintainer via [Issues](https://github.com/CJ-tpub/chatgpt-long-chat-smooth/issues).
