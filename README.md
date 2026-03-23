# koishi-plugin-aka-adapter-lark

对官方 `adapter-lark` 插件做增强优化的 Koishi 适配器分支，可直接替代官方 `adapter-lark` 使用。

相较于官方版本，这个分支默认会在收到飞书 / Lark 事件后补全用户资料：

- 保留 `open_id` 作为稳定的 `userId`
- 查询通讯录用户资料并补全 `session.event.user`
- 将用户名写入 `session.username`
- 将昵称写入 `session.author.nickname`
- 缓存用户资料，避免每条消息都请求 OpenAPI
- 可选将入站图片转成 `data:` URL，兼容不支持 `internal:` 资源协议的插件

## Why

官方适配器在消息适配阶段主要只写入 `open_id`。这会导致很多依赖 `session.username`、`session.author.nickname` 或 `session.event.user` 的插件拿不到可读用户信息。

这个分支的目标是保持上游行为兼容，同时让会话层面能直接拿到用户名和昵称。

当前仓库里的整体分层是：

- `aka-adapter-lark`: 负责飞书事件接入和 Koishi session 质量
- `aka-lark-center`: 负责飞书 API、权限、资源读取和 LLM / ChatLuna 可用表示

架构说明见：

- [`docs/lark-center-doc/architecture.md`](../../docs/lark-center-doc/architecture.md)
- [`docs/lark-center-doc/context-injection.md`](../../docs/lark-center-doc/context-injection.md)

## Config

除了官方 Lark / Feishu adapter 的常规配置外，新增了这些项：

- `hydrateUserProfile`: 是否在收到事件时补全用户资料，默认 `true`
- `profileCacheTtl`: 用户资料成功缓存时长，默认 `3600` 秒
- `profileFailureCacheTtl`: 用户资料查询失败缓存时长，默认 `300` 秒
- `incomingImageMode`: 入站图片输出格式，默认 `internal`，可设为 `data-url` 以兼容 ChatLuna 这类不支持 `internal:` 协议的插件

要让资料补全生效，你的飞书应用需要具备通讯录用户信息读取权限。

当 `incomingImageMode = data-url` 时，适配器会在收到图片消息后额外调用一次飞书资源接口，下载图片并内嵌为 base64 `data:` URL。这会增加单条图片消息的处理开销，但能直接兼容只能读取常规 URL 或 `data:` URL 的插件。

## Replace Official Adapter

1. 在 Koishi 项目里移除或停用官方 `adapter-lark`
2. 安装这个包
3. 使用 `aka-adapter-lark` 对应的插件入口配置机器人

这个包导出的仍然是完整的 Lark adapter，而不是包一层外围补丁。

## Scripts

```sh
pnpm build
pnpm typecheck
```

## Publish

```sh
pnpm run prepublishOnly
npm publish
```
