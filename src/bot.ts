import { Bot, Context, h, HTTP, Schema, Session, Time, Universal } from '@satorijs/core'
import { Im, User as LarkUser } from './types'
import { HttpServer } from './http'
import { WsClient } from './ws'
import { LarkMessageEncoder } from './message'
import { Internal } from './internal'
import * as Utils from './utils'
import { EditRelayState } from './features/edit-relay'
import {
  ErrorSurfacingState,
  extractLarkErrorInfo,
  formatErrorMessage,
  isSurfaceableError,
} from './features/error-surfacing'
import { ThinkingReactionState } from './features/thinking-reaction'

const fileTypeMap: Record<Exclude<Im.File.CreateForm['file_type'], 'stream'>, string[]> = {
  opus: ['audio/opus'],
  mp4: ['video/mp4'],
  pdf: ['application/pdf'],
  doc: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ppt: ['application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
}

interface HydratedUserProfile {
  user: Universal.User
  nickname?: string
}

interface CachedHydratedUserProfile {
  expiresAt: number
  profile: HydratedUserProfile | null
}

type IncomingImageMode = 'internal' | 'data-url'

/** Maximum number of data-url entries kept in the incoming image cache. */
const IMAGE_CACHE_MAX_SIZE = 256

function formatHydrationError(error: unknown) {
  if (error instanceof HTTP.Error && error.response?.data) {
    const data = error.response.data as { code?: number; msg?: string }
    if (typeof data.code === 'number' || typeof data.msg === 'string') {
      return `code=${data.code ?? 'unknown'}, msg=${data.msg ?? 'unknown'}`
    }
  }

  return String(error)
}

export class LarkBot<C extends Context = Context, T extends LarkBot.Config = LarkBot.Config> extends Bot<C, T> {
  static inject = ['http']
  static MessageEncoder = LarkMessageEncoder

  _refresher?: NodeJS.Timeout
  http: HTTP
  assetsQuester: HTTP
  internal: Internal<C>
  private userProfileCache = new Map<string, CachedHydratedUserProfile>()
  private userProfileRequests = new Map<string, Promise<HydratedUserProfile | null>>()
  private userProfileHydrationWarningEmitted = false
  private incomingImageUrlCache = new Map<string, string>()

  /** B 能力：编辑计数 + 续接重定向表。encoder 层直接访问。 */
  public readonly editRelay = new EditRelayState()
  private _editRelayCleanupTimer?: NodeJS.Timeout

  /** C 能力：失败提示排队（短延迟抑制）。encoder 层直接访问 enqueue。 */
  public readonly errorSurfacing = new ErrorSurfacingState()

  /** A 能力：思考期 reaction 追踪。 */
  public readonly thinkingReactions = new ThinkingReactionState()

  constructor(ctx: C, config: T) {
    super(ctx, config, 'lark')

    this.http = ctx.http.extend({
      endpoint: config.endpoint,
    })
    this.assetsQuester = ctx.http
    this.internal = new Internal(this)

    if (config.protocol === 'http') {
      ctx.plugin(HttpServer, this)
    } else if (config.protocol === 'ws') {
      ctx.plugin(WsClient, this as any)
    }

    // B 能力：定期清理过期的编辑续接重定向条目，防止内存无限增长
    if (config.messageEditRelay && config.messageEditRedirectTtlMs > 0) {
      const cleanupInterval = Math.max(60_000, Math.floor(config.messageEditRedirectTtlMs / 2))
      this._editRelayCleanupTimer = setInterval(() => {
        this.editRelay.cleanupExpired(config.messageEditRedirectTtlMs)
      }, cleanupInterval)
    }
    ctx.on('dispose', () => {
      if (this._editRelayCleanupTimer) {
        clearInterval(this._editRelayCleanupTimer)
        this._editRelayCleanupTimer = undefined
      }
      this.editRelay.clear()
      this.errorSurfacing.clear()
      this.thinkingReactions.clear()
    })

    this.defineInternalRoute('/*path', async ({ params, method, headers, body, query }) => {
      const response = await this.http('/' + params.path, {
        method,
        headers,
        data: method === 'GET' || method === 'HEAD' ? null : body,
        params: Object.fromEntries(query.entries()),
        responseType: 'arraybuffer',
        validateStatus: () => true,
      })
      return {
        status: response.status,
        body: response.data,
        headers: response.headers,
      }
    })
  }

  getResourceUrl(type: string, message_id: string, file_key: string) {
    return this.getInternalUrl(`/im/v1/messages/${message_id}/resources/${file_key}`, { type })
  }

  async getIncomingImageUrl(messageId: string, imageKey: string) {
    const fallbackUrl = this.getResourceUrl('image', messageId, imageKey)
    if (this.config.incomingImageMode !== 'data-url') {
      return fallbackUrl
    }

    const cacheKey = `${messageId}:${imageKey}`
    const cached = this.incomingImageUrlCache.get(cacheKey)
    if (cached) {
      return cached
    }

    try {
      const data = await this.internal.im.message.resource.get(messageId, imageKey, { type: 'image' })
      const dataUrl = Utils.createImageDataUrl(data)
      if (this.incomingImageUrlCache.size >= IMAGE_CACHE_MAX_SIZE) {
        // evict oldest entry (Map preserves insertion order)
        const oldest = this.incomingImageUrlCache.keys().next().value
        if (oldest !== undefined) this.incomingImageUrlCache.delete(oldest)
      }
      this.incomingImageUrlCache.set(cacheKey, dataUrl)
      return dataUrl
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.logger.warn(
        'failed to inline Lark image resource as data URL, falling back to internal URL: messageId=%s imageKey=%s detail=%s',
        messageId,
        imageKey,
        detail,
      )
      return fallbackUrl
    }
  }

  async initialize() {
    await this.refreshToken()
    const { bot } = await this.http.get<{
      bot: {
        activate_status: number
        app_name: string
        avatar_url: string
        ip_white_list: any[]
        open_id: string
      }
    }>('/bot/v3/info')
    this.selfId = bot.open_id
    this.user.avatar = bot.avatar_url
    this.user.name = bot.app_name
    this.online()
  }

  private async refreshToken() {
    // https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
    // tenant_access_token 的最大有效期是 2 小时。
    // 剩余有效期小于 30 分钟时，调用本接口会返回一个新的 tenant_access_token，此时会同时存在两个有效的 tenant_access_token。
    // 剩余有效期大于等于 30 分钟时，调用本接口会返回原有的 tenant_access_token。
    // 初次获得 token 后的半小时内必须刷新一次，因为初次获得的 token 可能是 1.5 小时前生成的。
    let timeout = Time.minute * 20
    try {
      const { tenant_access_token: token } = await this.internal.auth.tenantAccessTokenInternal({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      })
      this.logger.debug('refreshed token %s', token)
      this.http.config.headers!.Authorization = `Bearer ${token}`
    } catch (error) {
      this.logger.error('failed to refresh token, retrying in 10s')
      this.logger.error(error)
      timeout = Time.second * 10
    }
    if (this._refresher) clearTimeout(this._refresher)
    this._refresher = setTimeout(() => this.refreshToken(), timeout)
    this.online()
  }

  async editMessage(channelId: string, messageId: string, content: h.Fragment) {
    // B 能力：如果历史 messageId 已被续接过，把编辑请求重定向到最新的消息 id 上
    const effectiveId = this.config.messageEditRelay
      ? this.editRelay.resolve(messageId)
      : messageId
    if (effectiveId !== messageId) {
      this.logger.debug('editMessage redirected: prev=%s current=%s', messageId, effectiveId)
    }
    const encoder = new LarkMessageEncoder(this, channelId)
    encoder.editMessageIds = [effectiveId]
    await encoder.send(content)
  }

  /**
   * C 能力：把错误提示作为独立新消息发送。
   * 不走 encoder（避免递归），不 emit send（避免污染统计）。
   */
  async deliverErrorMessage(channelId: string, content: string): Promise<void> {
    try {
      await this.internal.im.message.create({
        receive_id: channelId,
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      }, {
        receive_id_type: Utils.extractIdType(channelId),
      })
      this.logger.info('surfaced error to user channel=%s content=%s', channelId, content)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.logger.warn('failed to deliver error message channel=%s detail=%s', channelId, detail)
    }
  }

  /**
   * A 能力：入站消息前置钩子。给用户消息加"思考中"reaction。
   * 必须 fire-and-forget（不阻塞 dispatch）。由 ws.ts / http.ts 调用。
   */
  async onInboundBeforeDispatch(body: Utils.EventPayload): Promise<void> {
    if (!this.config.thinkingReaction) return
    if (body.type !== 'im.message.receive_v1') return

    const event = body.event
    const messageId = event?.message?.message_id
    const chatId = event?.message?.chat_id
    if (!messageId || !chatId) return

    // 避免给机器人自己发的消息加 reaction（虽然通常入站事件不会包含自己）
    const senderType = event?.sender?.sender_type
    if (senderType === 'app') return

    if (this.thinkingReactions.has(messageId)) return

    try {
      const resp = await this.internal.im.message.reaction.create(messageId, {
        reaction_type: { emoji_type: this.config.thinkingReactionEmoji },
      })
      const reactionId = resp?.reaction_id
      if (!reactionId) {
        this.logger.warn('thinking reaction created but reactionId missing messageId=%s', messageId)
        return
      }
      this.thinkingReactions.register(
        messageId,
        chatId,
        reactionId,
        this.config.thinkingReactionTtlMs,
        (mid, rid) => this.deleteThinkingReaction(mid, rid),
      )
      this.logger.debug('thinking reaction added messageId=%s reactionId=%s emoji=%s',
        messageId, reactionId, this.config.thinkingReactionEmoji)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.logger.warn('failed to add thinking reaction messageId=%s detail=%s', messageId, detail)
    }
  }

  /**
   * A 能力：机器人在某会话 outbound 成功后调用。
   * 安排延迟撤销该会话下所有 pending 的思考期 reaction。
   */
  notifyOutboundForReaction(channelId: string): void {
    if (!this.config.thinkingReaction) return
    this.thinkingReactions.scheduleRetireForChannel(
      channelId,
      this.config.thinkingReactionRetireDelayMs,
      (mid, rid) => this.deleteThinkingReaction(mid, rid),
    )
  }

  /** 内部：撤销单个 reaction，失败 warn 不抛。 */
  private async deleteThinkingReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.internal.im.message.reaction.delete(messageId, reactionId)
      this.logger.debug('thinking reaction removed messageId=%s reactionId=%s', messageId, reactionId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.logger.warn(
        'failed to remove thinking reaction messageId=%s reactionId=%s detail=%s',
        messageId, reactionId, detail,
      )
    }
  }

  async deleteMessage(channelId: string, messageId: string) {
    await this.internal.im.message.delete(messageId)
  }

  async getMessage(channelId: string, messageId: string, recursive = true) {
    const data = await this.internal.im.message.get(messageId)
    const message = await Utils.decodeMessage(this, data.items![0], recursive)
    const im = await this.internal.im.chat.get(channelId)
    message.channel!.type = im.chat_mode === 'p2p' ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT
    return message
  }

  async getMessageList(channelId: string, before?: string) {
    const messages = await this.internal.im.message.list({ container_id_type: 'chat', container_id: channelId, page_token: before })
    const data = await Promise.all(messages.items.reverse().map(data => Utils.decodeMessage(this, data)))
    return { data, next: data[0]?.id }
  }

  async getUser(userId: string, guildId?: string) {
    const data = await this.internal.contact.user.get(userId)
    return Utils.decodeUser(data.user!)
  }

  async hydrateSessionUser(session: Session, userId = session.userId, idType: Utils.UserIdType = 'open_id') {
    if (!this.config.hydrateUserProfile || !userId) return

    const profile = await this.getHydratedUserProfile(userId, idType)
    if (!profile) return

    session.userId = profile.user.id
    session.event.user = {
      ...session.event.user,
      ...profile.user,
      id: profile.user.id,
      name: profile.user.name,
    }

    const nickname = profile.nickname || profile.user.name
    session.event.member = {
      ...session.event.member,
      user: {
        ...session.event.member?.user,
        ...profile.user,
        id: profile.user.id,
        name: profile.user.name,
      },
      name: nickname,
      nick: nickname,
      avatar: profile.user.avatar ?? session.event.member?.avatar,
    }
  }

  private summarizeText(value: string | undefined, fallback = '[empty]') {
    const normalized = (value || '').replace(/\s+/g, ' ').trim()
    return normalized || fallback
  }

  private getUserLabel(session: Session) {
    const userId = session.userId || session.event.user?.id || 'unknown'
    const userName = session.event.member?.name || session.event.user?.name
    return userName ? `${userName} (${userId})` : userId
  }

  private getChatKind(session: Session) {
    if (session.isDirect) return 'direct'
    if (session.channelId || session.guildId) return 'group'
    return 'unknown'
  }

  logIncomingSession(session: Session, body: Utils.EventPayload) {
    const userLabel = this.getUserLabel(session)
    const channelId = session.channelId || 'unknown'
    const chat = this.getChatKind(session)
    const eventType = body.type as string

    switch (body.type) {
      case 'im.message.receive_v1': {
        const content = this.summarizeText(session.content)
        const quoteId = session.quote?.id || body.event.message.parent_id || '-'
        const threadId = body.event.message.thread_id || '-'
        this.logger.info(
          'inbound user=%s content=%s kind=message event=%s chat=%s messageType=%s channel=%s messageId=%s threadId=%s quoteId=%s',
          userLabel,
          content,
          body.type,
          chat,
          body.event.message.message_type,
          channelId,
          body.event.message.message_id,
          threadId,
          quoteId,
        )
        return
      }
      case 'im.chat.access_event.bot_p2p_chat_entered_v1':
        this.logger.info(
          'inbound user=%s kind=event event=%s chat=%s channel=%s lastMessageId=%s',
          userLabel,
          body.type,
          chat,
          channelId,
          body.event.last_message_id || '-',
        )
        return
      case 'im.message.message_read_v1':
        this.logger.info(
          'inbound user=%s kind=event event=%s readAt=%s messageIds=%s',
          userLabel,
          body.type,
          body.event.reader.read_time,
          body.event.message_id_list.join(',') || '-',
        )
        return
      case 'application.bot.menu_v6':
        this.logger.info(
          'inbound user=%s kind=event event=%s chat=%s command=%s',
          userLabel,
          body.type,
          chat,
          body.event.event_key,
        )
        return
      case 'card.action.trigger':
        this.logger.info(
          'inbound user=%s kind=event event=%s chat=%s channel=%s actionTag=%s actionValue=%s',
          userLabel,
          body.type,
          chat,
          body.event.context.open_chat_id || channelId,
          body.event.action.tag,
          this.summarizeText(JSON.stringify(body.event.action.value), '[none]'),
        )
        return
      default:
        this.logger.info(
          'inbound user=%s kind=event event=%s chat=%s channel=%s',
          userLabel,
          eventType,
          chat,
          channelId,
        )
    }
  }

  logOutgoingMessage(entry: {
    operation: 'create' | 'reply' | 'edit'
    channelId: string
    messageId?: string
    messageType?: string
    content?: string
    chatKind?: string
    replyTo?: string
    replyInThread?: boolean
  }) {
    this.logger.info(
      'outbound content=%s kind=message operation=%s chat=%s channel=%s messageType=%s messageId=%s replyTo=%s threadReply=%s',
      this.summarizeText(entry.content),
      entry.operation,
      entry.chatKind || 'unknown',
      entry.channelId,
      entry.messageType || 'unknown',
      entry.messageId || '-',
      entry.replyTo || '-',
      entry.replyInThread ? 'yes' : 'no',
    )
  }

  private emitHydrationWarning(detail: string) {
    if (this.userProfileHydrationWarningEmitted) return
    this.userProfileHydrationWarningEmitted = true
    this.logger.warn('failed to hydrate Lark user profiles; incoming logs will fall back to user IDs until contact access is available: %s', detail)
  }

  private async getHydratedUserProfile(userId: string, idType: Utils.UserIdType): Promise<HydratedUserProfile | null> {
    const cacheKey = `${idType}:${userId}`
    const now = Date.now()
    const cached = this.userProfileCache.get(cacheKey)
    if (cached && cached.expiresAt > now) {
      return cached.profile
    }

    const pending = this.userProfileRequests.get(cacheKey)
    if (pending) {
      return await pending
    }

    const request = this.fetchHydratedUserProfile(userId, idType, cacheKey)
    this.userProfileRequests.set(cacheKey, request)
    try {
      return await request
    } finally {
      this.userProfileRequests.delete(cacheKey)
    }
  }

  private async fetchHydratedUserProfile(userId: string, idType: Utils.UserIdType, cacheKey: string): Promise<HydratedUserProfile | null> {
    try {
      const data = await this.internal.contact.user.get(userId, {
        user_id_type: idType,
      })
      const profile = data.user ? this.decodeHydratedUserProfile(data.user) : null
      if (!data.user) {
        this.emitHydrationWarning('empty user profile response')
      } else if (!profile?.user.name && !profile?.nickname) {
        this.emitHydrationWarning('user profile response does not contain readable name fields')
      }
      this.userProfileCache.set(cacheKey, {
        profile,
        expiresAt: Date.now() + this.config.profileCacheTtl * Time.second,
      })
      return profile
    } catch (error) {
      const detail = formatHydrationError(error)
      this.emitHydrationWarning(detail)
      this.logger.debug('failed to hydrate Lark user profile %s (%s): %s', userId, idType, detail)
      this.userProfileCache.set(cacheKey, {
        profile: null,
        expiresAt: Date.now() + this.config.profileFailureCacheTtl * Time.second,
      })
      return null
    }
  }

  private decodeHydratedUserProfile(user: LarkUser): HydratedUserProfile {
    return {
      user: Utils.decodeUser(user),
      nickname: user.nickname || user.name,
    }
  }

  async getChannel(channelId: string) {
    const chat = await this.internal.im.chat.get(channelId)
    return Utils.decodeChannel(channelId, chat)
  }

  async getChannelList(guildId: string) {
    return { data: [await this.getChannel(guildId)] }
  }

  async getGuild(guildId: string) {
    const chat = await this.internal.im.chat.get(guildId)
    return Utils.decodeGuild(chat)
  }

  async getGuildList(after?: string) {
    const chats = await this.internal.im.chat.list({ page_token: after })
    return { data: chats.items.map(Utils.decodeGuild), next: chats.page_token }
  }

  async getGuildMemberList(guildId: string, after?: string) {
    const members = await this.internal.im.chat.members.get(guildId, { page_token: after })
    const data = members.items!.map(v => ({ user: { id: v.member_id, name: v.name }, name: v.name }))
    return { data, next: members.page_token }
  }

  async createUpload(...uploads: Universal.Upload[]): Promise<string[]> {
    return await Promise.all(uploads.map(async (upload) => {
      let type: Im.File.CreateForm['file_type'] = 'stream'
      for (const [key, value] of Object.entries(fileTypeMap)) {
        if (value.includes(upload.type)) {
          type = key as Im.File.CreateForm['file_type']
          break
        }
      }
      const response = await this.internal.im.file.create({
        file_name: upload.filename,
        file_type: type,
        file: new Blob([upload.data]),
      })
      return this.getInternalUrl(`/im/v1/files/${response.file_key}`)
    }))
  }
}

export namespace LarkBot {
  export interface BaseConfig extends HTTP.Config {
    appId: string
    appSecret: string
    hydrateUserProfile: boolean
    profileCacheTtl: number
    profileFailureCacheTtl: number
    incomingImageMode: IncomingImageMode
    outgoingRichTextDebug: boolean
    thinkingReaction: boolean
    thinkingReactionEmoji: string
    thinkingReactionRetireDelayMs: number
    thinkingReactionTtlMs: number
    messageEditRelay: boolean
    messageEditThreshold: number
    messageEditRedirectTtlMs: number
    surfaceErrors: boolean
    errorSurfaceDelayMs: number
    errorMessageTemplate: string
  }

  export type Config = BaseConfig & (HttpServer.Options | WsClient.Options)

  export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
      platform: Schema.union(['feishu', 'lark']).default('feishu').description('平台名称。'),
      appId: Schema.string().required().description('机器人的应用 ID。'),
      appSecret: Schema.string().role('secret').required().description('机器人的应用密钥。'),
      hydrateUserProfile: Schema.boolean().default(true).description('收到事件时查询飞书通讯录并补全用户名称、昵称与头像。'),
      profileCacheTtl: Schema.number().min(60).default(3600).description('用户资料成功缓存时长，单位为秒。'),
      profileFailureCacheTtl: Schema.number().min(10).default(300).description('用户资料查询失败缓存时长，单位为秒。'),
      incomingImageMode: Schema.union(['internal', 'data-url']).default('internal').description('收到图片消息时输出的资源格式。`data-url` 可兼容不支持 `internal:` 协议的插件。'),
      outgoingRichTextDebug: Schema.boolean().default(false).description('输出富文本编码诊断日志，包含链接节点 children 和最终 post payload。仅建议排查渲染问题时临时开启。'),
      thinkingReaction: Schema.boolean().default(true).description('收到用户消息时立即在其消息上添加飞书表情，作为「机器人正在思考」的可见反馈。'),
      thinkingReactionEmoji: Schema.string().default('THINKING').description('用作思考中提示的飞书 emoji 类型（如 `THINKING`、`HOURGLASS`、`CLOCK`）。参考飞书官方 emoji 类型列表。'),
      thinkingReactionRetireDelayMs: Schema.number().min(0).default(3000).description('机器人首次向该会话发送/编辑消息后，延迟多少毫秒撤销思考表情。`0` 表示立即撤销。'),
      thinkingReactionTtlMs: Schema.number().min(1000).default(120000).description('思考表情的最长存活时长，用于兜底避免机器人未响应时表情永久残留。'),
      messageEditRelay: Schema.boolean().default(true).description('启用编辑上限自动续接：当同一条消息的编辑次数达到本地阈值或触发飞书 230072 时，自动切换为新消息继续写入，让流式回复不中断。'),
      messageEditThreshold: Schema.number().min(0).default(20).description('单条消息本地编辑次数阈值。达到后主动切换新消息，避免打到飞书上限。`0` 表示不做本地熔断，仅依赖飞书 230072 触发续接。'),
      messageEditRedirectTtlMs: Schema.number().min(10000).default(600000).description('编辑重定向表的过期时间。过期后旧 messageId 的编辑请求不再自动重定向到续接后的新消息。'),
      surfaceErrors: Schema.boolean().default(true).description('启用失败可见化：`sendMessage` / `editMessage` 抛出消息级错误时，向用户发送一条可读的失败提示。'),
      errorSurfaceDelayMs: Schema.number().min(0).default(500).description('错误提示延迟发送时长（毫秒）。延迟窗口内若同会话有新的成功发送，则抑制错误提示，避免 ChatLuna 内部重试成功后仍显示错误。'),
      errorMessageTemplate: Schema.string().default('[对话失败] Lark {code}: {msg}').description('失败提示消息模板，支持 `{code}` 和 `{msg}` 占位符。'),
      protocol: process.env.KOISHI_ENV === 'browser'
        ? Schema.const('ws').default('ws')
        : Schema.union(['http', 'ws']).description('选择要使用的协议。').default('http'),
    }),
    Schema.union([
      Schema.intersect([
        Schema.object({
          platform: Schema.const('lark').required(),
        }),
        HTTP.createConfig('https://open.larksuite.com/open-apis'),
        Schema.union([
          HttpServer.createConfig('/lark'),
          WsClient.Options,
        ]),
      ]),
      Schema.intersect([
        Schema.object({
          platform: Schema.const('feishu') as any,
        }),
        HTTP.createConfig('https://open.feishu.cn/open-apis'),
        Schema.union([
          HttpServer.createConfig('/feishu'),
          WsClient.Options,
        ]),
      ]),
    ]),
  ])
}

export { LarkBot as FeishuBot }
