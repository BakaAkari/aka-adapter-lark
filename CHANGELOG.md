# Changelog

## 0.4.0

ChatLuna 交互可见性改造（minor，无破坏性变更）。三个能力，均默认启用，可通过配置项关闭。

### 新增功能

- **思考期 reaction（A 能力）**：收到用户消息时立即在其消息上添加飞书表情（默认 `THINKING` 🤔），作为「机器人正在思考」的可见反馈。机器人首次向该会话发送/编辑消息后延迟 3 秒撤销 reaction。若机器人长时间不响应，reaction 会在 TTL（默认 2 分钟）到期后自动撤销。
- **编辑上限自动续接（B 能力）**：单条飞书消息编辑次数达到本地阈值（默认 20 次）或触发飞书 `230072` 错误时，自动把后续编辑内容作为新消息发出，并维护旧 → 新 messageId 的透明重定向，让 ChatLuna 等上游插件的流式回复不再因为编辑上限中断。
- **失败可见化（C 能力）**：`sendMessage` / `editMessage` 抛出「消息级」错误（如飞书 2300xx）时，向用户发送一条可读的失败提示。带短延迟抑制机制（默认 500ms），若延迟窗口内 ChatLuna 自动重试成功，则抑制该提示，避免"错误提示 + 正确回复"同时出现的错位。

### 新增配置项

- `thinkingReaction`（`boolean`，默认 `true`）：A 能力总开关
- `thinkingReactionEmoji`（`string`，默认 `'THINKING'`）：思考中提示的飞书 emoji type
- `thinkingReactionRetireDelayMs`（`number`，默认 `3000`）：outbound 后延迟多少毫秒撤销 reaction
- `thinkingReactionTtlMs`（`number`，默认 `120000`）：reaction 存活上限，超时强制撤销
- `messageEditRelay`（`boolean`，默认 `true`）：B 能力总开关
- `messageEditThreshold`（`number`，默认 `20`）：单条消息本地编辑次数阈值，`0` 表示禁用本地熔断仅依赖飞书 230072 触发续接
- `messageEditRedirectTtlMs`（`number`，默认 `600000`）：编辑重定向表条目过期时间
- `surfaceErrors`（`boolean`，默认 `true`）：C 能力总开关
- `errorSurfaceDelayMs`（`number`，默认 `500`）：错误提示延迟发送时长，用于抑制 ChatLuna 重试成功后的错误误报
- `errorMessageTemplate`（`string`，默认 `'[对话失败] Lark {code}: {msg}'`）：失败提示模板

### 权限要求

A 能力需要飞书应用具备 `im:message.reaction` 权限。若权限缺失，`reaction.create` 会失败，适配器将 warn 日志并跳过 reaction，不影响主流程。

### 相关文档

- 设计文档：[`plans/aka-adapter-lark-chatluna-progress-visibility.md`](../../plans/aka-adapter-lark-chatluna-progress-visibility.md)

## 0.3.2

- 移除出站链接文本的标点启发式拆分，改为确定性保留 Satori 链接节点边界
- 新增 `outgoingRichTextDebug` 诊断开关，用于记录链接 children 与最终飞书 post payload

## 0.3.1

- 曾尝试按标点拆分出站链接文本边界；该启发式方案已在 `0.3.2` 中移除，避免误伤合法链接标题

## 0.3.0

- 增强飞书 post 富文本文本渲染：
  - 出站支持原生文本、链接、@、粗体、斜体、下划线、删除线、代码块、分割线、图片和表情节点
  - 入站支持还原 post 文本样式、链接、@、表情
  - 增强 text 消息中的 Markdown 链接和 @ 提及解析

## 0.2.1

- 修复出站图片在飞书 post 消息中同时编码为 Markdown 图片和富文本图片块，导致用户看到两张相同图片的问题
