# koishi-plugin-aka-adapter-lark

对官方 `adapter-lark` 插件做增强优化的 Koishi 适配器分支，可直接替代官方 `adapter-lark` 使用。

相较于官方版本，这个分支默认会在收到飞书 / Lark 事件后补全用户资料，并针对 ChatLuna 流式对话场景做了交互可见性增强：

- 保留 `open_id` 作为稳定的 `userId`
- 查询通讯录用户资料并补全 `session.event.user`
- 将用户名写入 `session.username`
- 将昵称写入 `session.author.nickname`
- 缓存用户资料，避免每条消息都请求 OpenAPI
- 可选将入站图片转成 `data:` URL，兼容不支持 `internal:` 资源协议的插件
- 思考期在用户消息上加飞书表情反馈（`0.4.0+`）
- 编辑上限自动续接：单条消息编辑次数打满时自动切换新消息（`0.4.0+`）
- 失败可见化：`sendMessage` / `editMessage` 异常时向用户发送可读错误提示（`0.4.0+`）

## Why

官方适配器在消息适配阶段主要只写入 `open_id`。这会导致很多依赖 `session.username`、`session.author.nickname` 或 `session.event.user` 的插件拿不到可读用户信息。

这个分支的目标是保持上游行为兼容，同时让会话层面能直接拿到用户名和昵称。

当前仓库里的整体分层是：

- `aka-adapter-lark`: 负责飞书事件接入和 Koishi session 质量
- `aka-lark-center`: 负责飞书 API、权限、资源读取和 LLM / ChatLuna 可用表示

当前文档入口见：

- [`docs/active-documents.md`](../../docs/active-documents.md)
- [`docs/lark-center-doc/current-status.md`](../../docs/lark-center-doc/current-status.md)

历史架构和上下文注入说明已归档到 [`docs/archive/lark-center/`](../../docs/archive/lark-center/)，除非明确恢复历史线，否则不作为当前实现需求。

## Config

除了官方 Lark / Feishu adapter 的常规配置外，新增了这些项。

### 用户资料补全

- `hydrateUserProfile`: 是否在收到事件时补全用户资料，默认 `true`
- `profileCacheTtl`: 用户资料成功缓存时长，默认 `3600` 秒
- `profileFailureCacheTtl`: 用户资料查询失败缓存时长，默认 `300` 秒

要让资料补全生效，你的飞书应用需要具备通讯录用户信息读取权限。

### 图片入站格式

- `incomingImageMode`: 入站图片输出格式，默认 `internal`，可设为 `data-url` 以兼容 ChatLuna 这类不支持 `internal:` 协议的插件

当 `incomingImageMode = data-url` 时，适配器会在收到图片消息后额外调用一次飞书资源接口，下载图片并内嵌为 base64 `data:` URL。这会增加单条图片消息的处理开销，但能直接兼容只能读取常规 URL 或 `data:` URL 的插件。

### 富文本调试

- `outgoingRichTextDebug`: 输出富文本编码诊断日志，默认 `false`。仅建议排查渲染问题时临时开启。

### 思考期 reaction（`0.4.0+`）

- `thinkingReaction`: 收到用户消息时立即在其消息上添加飞书表情，作为「思考中」反馈。默认 `true`
- `thinkingReactionEmoji`: 用作思考中提示的飞书 emoji 类型（如 `THINKING`、`HOURGLASS`、`CLOCK`），默认 `'THINKING'`
- `thinkingReactionRetireDelayMs`: 机器人首次向该会话发送/编辑消息后，延迟多少毫秒撤销 reaction，默认 `3000`。`0` 表示立即撤销
- `thinkingReactionTtlMs`: reaction 存活上限，超时自动撤销，默认 `120000`（2 分钟）

需要飞书应用具备 `im:message.reaction` 权限。若权限缺失，reaction 相关请求会失败并降级为 warn 日志，不影响主流程。

### 编辑上限自动续接（`0.4.0+`）

ChatLuna 等上游插件对同一条飞书消息高频调用 `editMessage`，飞书对单条消息编辑次数有上限（返回 `230072`）。启用后本地会计数并主动切换新消息，或在飞书报错时透明续接：

- `messageEditRelay`: 总开关，默认 `true`
- `messageEditThreshold`: 单条消息本地编辑次数阈值。达到后主动切换新消息，默认 `20`。`0` 表示禁用本地熔断，仅依赖飞书 `230072` 触发续接
- `messageEditRedirectTtlMs`: 编辑重定向表的过期时间，默认 `600000`（10 分钟）

对普通命令回复无副作用（因为普通回复不会高频编辑同一条消息）。

### 失败可见化（`0.4.0+`）

`sendMessage` / `editMessage` 抛出「消息级」错误（飞书 `2300xx` 段）时，向用户发送可读的失败提示：

- `surfaceErrors`: 总开关，默认 `true`
- `errorSurfaceDelayMs`: 错误提示延迟发送时长（毫秒），默认 `500`。延迟窗口内若同会话有新的成功发送，则抑制提示，避免 ChatLuna 内部重试成功后仍显示错误
- `errorMessageTemplate`: 失败提示模板，默认 `'[对话失败] Lark {code}: {msg}'`，支持 `{code}` 和 `{msg}` 占位符

## Replace Official Adapter

1. 在 Koishi 项目里移除或停用官方 `adapter-lark`
2. 安装这个包
3. 使用 `aka-adapter-lark` 对应的插件入口配置机器人

这个包导出的仍然是完整的 Lark adapter，而不是包一层外围补丁。

## Changelog

版本历史迁移至独立文件：[`CHANGELOG.md`](./CHANGELOG.md)。

## Scripts

```sh
pnpm build
pnpm typecheck
```

## Publish

Publish from the repository root with the workspace release script. This is a manual user action, not an automatic LLM action.

```sh
./push.sh aka-adapter-lark
```
