import { Bot, Context, h, HTTP, Schema, Session, Time, Universal } from '@satorijs/core'
import { Im, User as LarkUser } from './types'
import { HttpServer } from './http'
import { WsClient } from './ws'
import { LarkMessageEncoder } from './message'
import { Internal } from './internal'
import * as Utils from './utils'

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

export class LarkBot<C extends Context = Context, T extends LarkBot.Config = LarkBot.Config> extends Bot<C, T> {
  static inject = ['http']
  static MessageEncoder = LarkMessageEncoder

  _refresher?: NodeJS.Timeout
  http: HTTP
  assetsQuester: HTTP
  internal: Internal<C>
  private userProfileCache = new Map<string, CachedHydratedUserProfile>()
  private userProfileRequests = new Map<string, Promise<HydratedUserProfile | null>>()

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
    const encoder = new LarkMessageEncoder(this, channelId)
    encoder.editMessageIds = [messageId]
    await encoder.send(content)
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
      this.userProfileCache.set(cacheKey, {
        profile,
        expiresAt: Date.now() + this.config.profileCacheTtl * Time.second,
      })
      return profile
    } catch (error) {
      this.logger.debug('failed to hydrate Lark user profile %s (%s): %s', userId, idType, error)
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
