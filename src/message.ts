import { Context, Dict, h, MessageEncoder } from '@satorijs/core'
import { LarkBot } from './bot'
import { Im, Message } from './types'
import { EventPayload, extractIdType } from './utils'
import { MessageContent } from './content'
import { isEditExhausted } from './features/edit-relay'
import {
  extractLarkErrorInfo,
  formatErrorMessage,
  isSurfaceableError,
} from './features/error-surfacing'

export class LarkMessageEncoder<C extends Context = Context> extends MessageEncoder<C, LarkBot<C>> {
  declare referrer?: EventPayload

  private quote: Dict | undefined
  private textContent = ''
  private richContent: MessageContent.RichText.Paragraph[] = []
  private richParagraph: MessageContent.RichText.InlineElement[] = []
  private currentStyles: MessageContent.RichText.Style[] = []
  private card: MessageContent.Card | undefined
  private elements: MessageContent.Card.Element[] = []
  private inline = false

  public editMessageIds: string[] | undefined

  async post(data?: any, logContent?: string) {
    try {
      let resp: Message
      let quote = this.quote
      let operation: 'create' | 'reply' | 'edit' = 'create'
      if (!quote && this.referrer) {
        if (this.referrer.type === 'im.message.receive_v1' && this.referrer.event.message.thread_id) {
          quote = {
            id: this.referrer.event.message.message_id,
            replyInThread: true,
          }
        } else if (this.referrer.type === 'card.action.trigger') {
          // cannot determine whether the card is in thread or not
          const { items: [message] } = await this.bot.internal.im.message.get(this.referrer.event.context.open_message_id)
          if (message?.thread_id) {
            quote = {
              id: this.referrer.event.context.open_message_id,
              replyInThread: true,
            }
          }
        }
      }
      if (this.editMessageIds) {
        operation = 'edit'
        const messageId = this.editMessageIds.pop()
        if (!messageId) throw new Error('No message to edit')

        // B 能力：达到本地阈值时提前熔断，直接走续接
        const relayEnabled = this.bot.config.messageEditRelay
        const threshold = this.bot.config.messageEditThreshold
        if (relayEnabled && this.bot.editRelay.isLocalExhausted(messageId, threshold)) {
          await this.relayAsNew(messageId, data, logContent, 'local-threshold', quote)
          return
        }

        const messageTypeForLog = data?.msg_type
        try {
          if (data.msg_type === 'interactive') {
            // patch 请求体不能包含 msg_type
            const patchPayload = { ...data }
            delete patchPayload.msg_type
            await this.bot.internal.im.message.patch(messageId, patchPayload)
          } else {
            await this.bot.internal.im.message.update(messageId, data)
          }
          this.bot.editRelay.incrementEdit(messageId)
          this.bot.logOutgoingMessage({
            operation,
            channelId: this.channelId,
            messageId,
            messageType: messageTypeForLog,
            content: logContent,
            chatKind: this.session.isDirect ? 'direct' : (this.session.channelId || this.session.guildId ? 'group' : 'unknown'),
          })
          // C 能力：成功编辑视为一次成功 outbound，抑制排队中的错误提示
          this.bot.errorSurfacing.consume(this.channelId)
          // A 能力：成功 outbound，安排延迟撤销该会话的思考期 reaction
          this.bot.notifyOutboundForReaction(this.channelId)
          return
        } catch (editError) {
          // B 能力：飞书 230072 表示编辑次数打满，透明续接为新消息
          if (relayEnabled && isEditExhausted(editError)) {
            await this.relayAsNew(messageId, data, logContent, 'lark-230072', quote)
            return
          }
          throw editError
        }
      } else if (quote?.id) {
        operation = 'reply'
        resp = await this.bot.internal.im.message.reply(quote.id, {
          ...data,
          reply_in_thread: quote.replyInThread,
        })
      } else {
        operation = 'create'
        data.receive_id = this.channelId
        resp = await this.bot.internal.im.message.create(data, {
          receive_id_type: extractIdType(this.channelId),
        })
      }
      if (!resp) return
      this.bot.logOutgoingMessage({
        operation,
        channelId: this.channelId,
        messageId: resp.message_id,
        messageType: data?.msg_type,
        content: logContent,
        chatKind: this.session.isDirect ? 'direct' : (this.session.channelId || this.session.guildId ? 'group' : 'unknown'),
        replyTo: quote?.id,
        replyInThread: quote?.replyInThread,
      })
      const session = this.bot.session()
      session.messageId = resp.message_id
      session.timestamp = Number(resp.create_time) * 1000
      session.userId = resp.sender.id
      session.channelId = this.session.channelId
      session.guildId = this.session.guildId
      session.app.emit(session, 'send', session)
      this.results.push(session.event.message)
      // C 能力：成功发送视为一次成功 outbound，抑制排队中的错误提示
      this.bot.errorSurfacing.consume(this.channelId)
      // A 能力：成功 outbound，安排延迟撤销该会话的思考期 reaction
      this.bot.notifyOutboundForReaction(this.channelId)
    } catch (e) {
      // try to extract error message from Lark API
      if (this.bot.http.isError(e)) {
        if (e.response?.data?.code) {
          const generalErrorMsg = `Check error code at https://open.larksuite.com/document/server-docs/getting-started/server-error-codes`
          e.message += ` (Lark error code ${e.response.data.code}: ${e.response.data.msg ?? generalErrorMsg})`
        }
      }
      // C 能力：如果是「消息级」错误且启用了 surfaceErrors，排队一条用户可见提示
      if (this.bot.config.surfaceErrors && isSurfaceableError(e)) {
        const info = extractLarkErrorInfo(e)
        const content = formatErrorMessage(this.bot.config.errorMessageTemplate, info)
        this.bot.errorSurfacing.enqueue(
          this.channelId,
          content,
          this.bot.config.errorSurfaceDelayMs,
          (channelId, text) => this.bot.deliverErrorMessage(channelId, text),
        )
        this.bot.logger.warn(
          'queued surfaceable error channel=%s code=%s msg=%s delayMs=%d',
          this.channelId,
          info.code,
          info.msg,
          this.bot.config.errorSurfaceDelayMs,
        )
      }
      this.errors.push(e)
    }
  }

  /**
   * B 能力：编辑达到本地阈值或飞书 230072 时，把当次编辑内容作为新消息发出，
   * 并把 old → new 登记到 bot.editRelay，让后续对旧 messageId 的编辑透明重定向。
   *
   * 走 quote 或 create 路径，取决于是否有 referrer / quote。
   * 卡片消息（interactive）不 reply，直接 create，避免嵌在引用块里。
   */
  private async relayAsNew(
    prevMessageId: string,
    data: any,
    logContent: string | undefined,
    reason: 'local-threshold' | 'lark-230072',
    quote: Dict | undefined,
  ): Promise<void> {
    const factory = async (): Promise<string> => {
      let resp: Message
      let operation: 'create' | 'reply' = 'create'
      const msgType = data?.msg_type
      const canReply = msgType !== 'interactive' && quote?.id

      if (canReply) {
        operation = 'reply'
        resp = await this.bot.internal.im.message.reply(quote.id, {
          ...data,
          reply_in_thread: quote.replyInThread,
        })
      } else {
        operation = 'create'
        const createPayload = { ...data, receive_id: this.channelId }
        resp = await this.bot.internal.im.message.create(createPayload, {
          receive_id_type: extractIdType(this.channelId),
        })
      }

      if (!resp) {
        throw new Error('edit relay: empty response from Lark on create/reply')
      }

      this.bot.logger.info(
        'edit relayed prev=%s new=%s reason=%s operation=%s',
        prevMessageId,
        resp.message_id,
        reason,
        operation,
      )

      // 登记重定向：后续 chatluna 用 prev id 编辑时会被解析到 new id
      this.bot.editRelay.recordRedirect(prevMessageId, resp.message_id)

      this.bot.logOutgoingMessage({
        operation,
        channelId: this.channelId,
        messageId: resp.message_id,
        messageType: msgType,
        content: logContent,
        chatKind: this.session.isDirect
          ? 'direct'
          : (this.session.channelId || this.session.guildId ? 'group' : 'unknown'),
        replyTo: canReply ? quote?.id : undefined,
        replyInThread: canReply ? quote?.replyInThread : undefined,
      })

      // 续接产生的是一条新消息，emit send 事件让 Koishi 记录一致
      const emitSession = this.bot.session()
      emitSession.messageId = resp.message_id
      emitSession.timestamp = Number(resp.create_time) * 1000
      emitSession.userId = resp.sender.id
      emitSession.channelId = this.session.channelId
      emitSession.guildId = this.session.guildId
      emitSession.app.emit(emitSession, 'send', emitSession)
      this.results.push(emitSession.event.message)
      // C 能力：续接成功也是一次成功 outbound，抑制排队中的错误提示
      this.bot.errorSurfacing.consume(this.channelId)
      // A 能力：续接成功也算 outbound，安排延迟撤销思考期 reaction
      this.bot.notifyOutboundForReaction(this.channelId)

      return resp.message_id
    }

    try {
      await this.bot.editRelay.serializeRelay(prevMessageId, factory)
    } catch (relayError) {
      // 续接失败时把错误压入 errors，交给上层（chatluna）处理
      if (this.bot.http.isError(relayError)) {
        if (relayError.response?.data?.code) {
          const generalErrorMsg = `Check error code at https://open.larksuite.com/document/server-docs/getting-started/server-error-codes`
          relayError.message += ` (Lark error code ${relayError.response.data.code}: ${relayError.response.data.msg ?? generalErrorMsg})`
        }
      }
      // C 能力：续接失败也走排队错误提示（往往是真实的消息级错误）
      if (this.bot.config.surfaceErrors && isSurfaceableError(relayError)) {
        const info = extractLarkErrorInfo(relayError)
        const content = formatErrorMessage(this.bot.config.errorMessageTemplate, info)
        this.bot.errorSurfacing.enqueue(
          this.channelId,
          content,
          this.bot.config.errorSurfaceDelayMs,
          (channelId, text) => this.bot.deliverErrorMessage(channelId, text),
        )
        this.bot.logger.warn(
          'queued surfaceable relay error channel=%s code=%s msg=%s',
          this.channelId,
          info.code,
          info.msg,
        )
      }
      this.errors.push(relayError)
    }
  }

  private createStyledElement<T extends MessageContent.RichText.TextElement | MessageContent.RichText.LinkElement | MessageContent.RichText.AtElement>(element: T): T {
    if (this.currentStyles.length) {
      return { ...element, style: [...new Set(this.currentStyles)] } as T
    }
    return element
  }

  private pushRichInline(element: MessageContent.RichText.InlineElement) {
    if (this.card) return
    this.richParagraph.push(element)
  }

  private flushRichParagraph() {
    if (!this.richParagraph.length) return
    this.richContent.push(this.richParagraph)
    this.richParagraph = []
  }

  private pushRichBlock(element: MessageContent.RichText.BlockElement) {
    this.flushRichParagraph()
    this.richContent.push([element])
  }

  private appendRichText(text: string) {
    if (!text) return
    const lines = text.split('\n')
    lines.forEach((line, index) => {
      if (index) this.flushRichParagraph()
      if (!line) return
      this.pushRichInline(this.createStyledElement({
        tag: 'text',
        text: line,
      }))
    })
  }

  private flushText() {
    if (!this.textContent) return
    if (this.card) {
      this.elements.push({ tag: 'markdown', content: this.textContent })
    } else {
      this.appendRichText(this.textContent)
    }
    this.textContent = ''
  }

  private describeElementTree(elements: h[]): unknown[] {
    return elements.map((element) => {
      const attrs = element.attrs ?? {}
      return {
        type: element.type,
        attrs: element.type === 'text'
          ? { content: attrs.content }
          : Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== 'src' && key !== 'url')),
        children: element.children?.length ? this.describeElementTree(element.children) : undefined,
      }
    })
  }

  private logRichTextDebug(message: string, data: Record<string, unknown>) {
    if (!this.bot.config.outgoingRichTextDebug) return
    this.bot.logger.debug('%s %o', message, JSON.parse(JSON.stringify(data)))
  }

  private async collectText(children: h[]) {
    const previousText = this.textContent
    const previousParagraph = this.richParagraph
    const previousStyles = this.currentStyles
    const previousElements = this.elements
    const previousInline = this.inline
    const previousRichContent = this.richContent

    this.textContent = ''
    this.richParagraph = []
    this.currentStyles = []
    this.elements = []
    this.inline = true
    this.richContent = []

    try {
      await this.render(children)
      return this.textContent
        || this.richParagraph.map((item) => {
          if (item.tag === 'text') return item.text
          if (item.tag === 'a') return item.text
          if (item.tag === 'at') return item.user_id
          if (item.tag === 'emotion' || item.tag === 'emoji') return item.emoji_type
          return item.tag === 'md' ? item.text : ''
        }).join('')
        || this.elements.map((item) => 'content' in item ? String(item.content) : '').join('')
    } finally {
      this.textContent = previousText
      this.richParagraph = previousParagraph
      this.currentStyles = previousStyles
      this.elements = previousElements
      this.inline = previousInline
      this.richContent = previousRichContent
    }
  }

  private async renderWithStyle(style: MessageContent.RichText.Style, children: h[]) {
    this.currentStyles.push(style)
    try {
      await this.render(children)
    } finally {
      this.currentStyles.pop()
    }
  }

  private describeRichContent() {
    const text = this.richContent.flat().map((item) => {
      if ('text' in item && typeof item.text === 'string') return item.text
      if (item.tag === 'img') return '[image]'
      if (item.tag === 'a') return '[link]'
      if (item.tag === 'hr') return '[divider]'
      return ''
    }).join(' ')
    return text || '[post]'
  }

  private describeCard(card: MessageContent.Card) {
    const parts: string[] = []
    const visit = (value: unknown) => {
      if (!value) return
      if (typeof value === 'string') {
        parts.push(value)
        return
      }
      if (Array.isArray(value)) {
        value.forEach(visit)
        return
      }
      if (typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (['content', 'text', 'title', 'subtitle', 'label', 'name', 'value', 'placeholder'].includes(key)) {
            visit(child)
          } else if (typeof child === 'object') {
            visit(child)
          }
        }
      }
    }
    visit(card)
    return parts.join(' ').replace(/\s+/g, ' ').trim() || '[card]'
  }

  async flush() {
    this.flushText()
    this.flushRichParagraph()
    if (!this.card && !this.richContent.length) return

    if (this.card) {
      // strip undefined properties
      this.bot.logger.debug('card %o', JSON.parse(JSON.stringify(this.card)))
      const logContent = this.describeCard(this.card)
      await this.post({
        msg_type: 'interactive',
        content: JSON.stringify(this.card),
      }, logContent)
    } else {
      const logContent = this.describeRichContent()
      const content = {
        zh_cn: {
          content: this.richContent,
        },
      }
      this.logRichTextDebug('outbound rich post payload', { content })
      await this.post({
        msg_type: 'post',
        content: JSON.stringify(content),
      }, logContent)
    }

    // reset cached content
    this.quote = undefined
    this.textContent = ''
    this.richContent = []
    this.richParagraph = []
    this.currentStyles = []
    this.card = undefined
    this.elements = []
  }

  async createImage(url: string) {
    const maxRetries = 2
    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { filename, type, data } = await this.bot.assetsQuester.file(url)
        const { image_key } = await this.bot.internal.im.image.create({
          image_type: 'message',
          image: new File([data], filename, { type }),
        })
        return image_key
      } catch (error) {
        lastError = error
        if (attempt < maxRetries) {
          const delay = (attempt + 1) * 2000
          this.bot.logger.warn(
            'createImage attempt %d/%d failed, retrying in %dms: %s',
            attempt + 1,
            maxRetries + 1,
            delay,
            error instanceof Error ? error.message : String(error),
          )
          await new Promise(resolve => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError
  }

  async sendFile(_type: 'video' | 'audio' | 'file', attrs: any) {
    const url: string = attrs.src || attrs.url
    const prefix = this.bot.getInternalUrl('/im/v1/files/')
    if (url.startsWith(prefix)) {
      const file_key = url.slice(prefix.length)
      await this.post({
        msg_type: _type === 'video' ? 'media' : _type,
        content: JSON.stringify({ file_key }),
      }, `[${_type}] ${attrs.title || attrs.fileName || file_key}`)
      return
    }

    const { filename, type, data } = await this.bot.assetsQuester.file(url)

    let file_type: Im.File.CreateForm['file_type']
    if (_type === 'audio') {
      // FIXME: only support opus
      file_type = 'opus'
    } else if (_type === 'video') {
      // FIXME: only support mp4
      file_type = 'mp4'
    } else {
      const ext = filename.split('.').pop()
      if (['doc', 'xls', 'ppt', 'pdf'].includes(ext)) {
        file_type = ext as any
      } else {
        file_type = 'stream'
      }
    }

    const form: Im.File.CreateForm = {
      file_type,
      file: new File([data], filename, { type }),
      file_name: filename,
    }
    if (attrs.duration) {
      form.duration = attrs.duration
    }

    const { file_key } = await this.bot.internal.im.file.create(form)
    await this.post({
      msg_type: _type === 'video' ? 'media' : _type,
      content: JSON.stringify({ file_key }),
    }, `[${_type}] ${filename}`)
  }

  private createBehaviors(attrs: Dict) {
    const behaviors: MessageContent.Card.ActionBehavior[] = []
    if (attrs.type === 'link') {
      behaviors.push({
        type: 'open_url',
        default_url: attrs.href,
      })
    } else if (attrs.type === 'input' || attrs.type === 'submit') {
      behaviors.push({
        type: 'callback',
        value: {
          _satori_type: 'command',
          content: attrs.text,
        },
      })
    } else if (attrs.type === 'action') {
      // TODO
    }
    return behaviors.length ? behaviors : undefined
  }

  async visit(element: h) {
    const { type, attrs, children } = element
    if (type === 'text') {
      if (this.card || !this.currentStyles.length) {
        this.textContent += attrs.content
      } else {
        this.flushText()
        this.appendRichText(attrs.content)
      }
    } else if (type === 'at') {
      if (this.card) {
        if (attrs.type === 'all') {
          this.textContent += `<at id=all>${attrs.name ?? ''}</at>`
        } else {
          this.textContent += `<at id=${attrs.id}>${attrs.name ?? ''}</at>`
        }
      } else {
        this.flushText()
        this.pushRichInline(this.createStyledElement({
          tag: 'at',
          user_id: attrs.type === 'all' ? 'all' : attrs.id,
        }))
      }
    } else if (type === 'a') {
      if (this.card) {
        const text = await this.collectText(children)
        this.logRichTextDebug('outbound link encode', {
          mode: 'card',
          href: attrs.href,
          text,
          children: this.describeElementTree(children),
        })
        this.textContent += attrs.href ? `[${text || attrs.href}](${attrs.href})` : text
      } else {
        this.flushText()
        const text = await this.collectText(children)
        this.logRichTextDebug('outbound link encode', {
          mode: 'post',
          href: attrs.href,
          text,
          children: this.describeElementTree(children),
        })
        if (attrs.href) {
          this.pushRichInline(this.createStyledElement({
            tag: 'a',
            text: text || attrs.href,
            href: attrs.href,
          }))
        } else {
          this.textContent += text
        }
      }
    } else if (type === 'p') {
      if (this.card) {
        if (!this.textContent.endsWith('\n')) this.textContent += '\n'
        await this.render(children)
        if (!this.textContent.endsWith('\n')) this.textContent += '\n'
      } else {
        this.flushText()
        await this.render(children)
        this.flushText()
        this.flushRichParagraph()
      }
    } else if (type === 'br') {
      if (this.card) {
        this.textContent += '\n'
      } else {
        this.flushText()
        this.flushRichParagraph()
      }
    } else if (type === 'sharp') {
      // platform does not support sharp
    } else if (type === 'quote') {
      await this.flush()
      this.quote = attrs
    } else if (type === 'b' || type === 'strong') {
      await this.renderWithStyle('bold', children)
    } else if (type === 'i' || type === 'em') {
      await this.renderWithStyle('italic', children)
    } else if (type === 'u') {
      await this.renderWithStyle('underline', children)
    } else if (type === 's' || type === 'del') {
      await this.renderWithStyle('lineThrough', children)
    } else if (type === 'code') {
      if (this.card) {
        this.textContent += '`'
        await this.render(children)
        this.textContent += '`'
      } else {
        this.flushText()
        const text = await this.collectText(children)
        this.pushRichBlock({ tag: 'code_block', text })
      }
    } else if (type === 'pre') {
      this.flushText()
      const text = await this.collectText(children)
      if (this.card) {
        this.textContent += `\n\`\`\`\n${text}\n\`\`\`\n`
      } else {
        this.pushRichBlock({ tag: 'code_block', language: attrs.lang || attrs.language, text })
      }
    } else if (type === 'face' || type === 'emoji') {
      if (this.card) {
        this.textContent += attrs.name || attrs.id || attrs.emojiType || ''
      } else {
        this.flushText()
        const emoji_type = attrs.id || attrs.emojiType || attrs.name
        if (emoji_type) this.pushRichInline({ tag: 'emotion', emoji_type })
      }
    } else if (type === 'img' || type === 'image') {
      this.flushText()
      const image_key = await this.createImage(attrs.src || attrs.url)
      this.pushRichBlock({ tag: 'img', image_key })
    } else if (['video', 'audio', 'file'].includes(type)) {
      await this.flush()
      await this.sendFile(type as any, attrs)
    } else if (type === 'lark:img') {
      this.flushText()
      if (!this.card && attrs.imgKey) this.pushRichBlock({ tag: 'img', image_key: attrs.imgKey })
      this.elements.push({
        tag: 'img',
        alt: attrs.alt,
        img_key: attrs.imgKey,
        transparent: attrs.transparent,
        preview: attrs.preview,
        corner_radius: attrs.cornerRadius,
        scale_type: attrs.scaleType,
        size: attrs.size,
        mode: attrs.mode,
        margin: attrs.margin,
      })
    } else if (type === 'figure' || type === 'message') {
      await this.flush()
      await this.render(children, true)
    } else if (type === 'hr') {
      this.flushText()
      this.pushRichBlock({ tag: 'hr' })
      this.elements.push({
        tag: 'hr',
        margin: attrs.margin,
      })
    } else if (type === 'form') {
      this.flushText()
      const parent = this.elements
      parent.push({
        tag: 'form',
        name: attrs.name || 'Form',
        elements: this.elements = [],
      })
      await this.render(children)
      this.elements = parent
    } else if (type === 'input') {
      if (attrs.type === 'checkbox') {
        this.flushText()
        await this.render(children)
        this.elements.push({
          tag: 'checker',
          name: (attrs.argument ? '@@' : attrs.option ? `@${attrs.option}=` : '') + attrs.name,
          checked: attrs.value,
          disabled: attrs.disabled,
          text: {
            tag: 'lark_md',
            content: this.textContent,
          },
          hover_tips: attrs.hoverTips && {
            tag: 'plain_text',
            content: attrs.hoverTips,
          },
          disabled_tips: attrs.disabledTips && {
            tag: 'plain_text',
            content: attrs.disabledTips,
          },
          behaviors: this.createBehaviors(attrs),
          margin: attrs.margin,
        })
        this.textContent = ''
      } else if (attrs.type === 'submit') {
        this.flushText()
        await this.render(children)
        this.elements.push({
          tag: 'button',
          name: attrs.name,
          width: attrs.width,
          text: {
            tag: 'plain_text',
            content: this.textContent,
          },
          form_action_type: 'submit',
          behaviors: this.createBehaviors(attrs),
          margin: attrs.margin,
        })
        this.textContent = ''
      } else {
        this.flushText()
        const input: MessageContent.Card.InputElement = {
          tag: 'input',
          name: attrs.name,
          width: attrs.width,
          label: attrs.label && {
            tag: 'plain_text',
            content: attrs.label,
          },
          placeholder: attrs.placeholder && {
            tag: 'plain_text',
            content: attrs.placeholder,
          },
          disabled_tips: attrs.disabledTips && {
            tag: 'plain_text',
            content: attrs.disabledTips,
          },
          default_value: attrs.value,
          disabled: attrs.disabled,
          required: attrs.required,
          behaviors: this.createBehaviors(attrs),
          margin: attrs.margin,
        }
        this.elements.push(input)
      }
    } else if (type === 'select') {
      this.flushText()
      const select: MessageContent.Card.SelectElement = {
        tag: 'select_static',
        name: attrs.name,
        width: attrs.width,
        initial_option: attrs.value,
        disabled: attrs.disabled,
        required: attrs.required,
        placeholder: attrs.placeholder && {
          tag: 'plain_text',
          content: attrs.placeholder,
        },
        options: [],
        behaviors: this.createBehaviors(attrs),
        margin: attrs.margin,
      }
      for (const child of children) {
        if (child.type !== 'option') continue
        await this.render(child.children)
        select.options.push({
          value: child.attrs.value,
          text: {
            tag: 'plain_text',
            content: this.textContent ?? child.attrs.value,
          },
        })
        this.textContent = ''
      }
      this.elements.push(select)
    } else if (type === 'button') {
      this.flushText()
      await this.render(children)
      this.elements.push({
        tag: 'button',
        text: {
          tag: 'plain_text',
          content: this.textContent,
        },
        disabled: attrs.disabled,
        type: attrs['lark:type'],
        size: attrs['lark:size'],
        width: attrs['lark:width'],
        icon: attrs['lark:icon'] && {
          tag: 'standard_icon',
          token: attrs['lark:icon'],
          color: attrs['lark:icon-color'],
        },
        hover_tips: attrs.hoverTips && {
          tag: 'plain_text',
          content: attrs.hoverTips,
        },
        disabled_tips: attrs.disabledTips && {
          tag: 'plain_text',
          content: attrs.disabledTips,
        },
        behaviors: this.createBehaviors(attrs),
        margin: attrs.margin,
      })
      this.textContent = ''
    } else if (type === 'div') {
      this.flushText()
      this.inline = true
      await this.render(children)
      this.inline = false
      this.elements.push({
        tag: 'markdown',
        text_align: attrs.align,
        text_size: attrs.size,
        content: this.textContent,
        margin: attrs.margin,
        icon: attrs.icon && {
          tag: 'standard_icon',
          token: attrs.icon,
          color: attrs.iconColor,
        },
      })
      this.textContent = ''
    } else if (type.startsWith('lark:') || type.startsWith('feishu:')) {
      const tag = type.slice(type.split(':', 1)[0].length + 1)
      if (tag === 'share-chat') {
        await this.flush()
        await this.post({
          msg_type: 'share_chat',
          content: JSON.stringify({ chat_id: attrs.chatId }),
        })
      } else if (tag === 'share-user') {
        await this.flush()
        await this.post({
          msg_type: 'share_user',
          content: JSON.stringify({ user_id: attrs.userId }),
        })
      } else if (tag === 'system') {
        await this.flush()
        await this.render(children)
        await this.post({
          msg_type: 'system',
          content: JSON.stringify({
            type: 'divider',
            params: { divider_text: { text: this.textContent } },
            options: { need_rollup: attrs.needRollup },
          }),
        })
        this.textContent = ''
      } else if (tag === 'card') {
        await this.flush()
        this.card = {
          schema: '2.0',
          config: {
            summary: attrs.summary && {
              content: attrs.summary,
            },
            enable_forward: attrs.enableForward,
            update_multi: attrs.updateMulti,
            enable_forward_interaction: attrs.enableForwardInteraction,
            style: typeof attrs.style === 'string' ? JSON.parse(attrs.style) : attrs.style,
          },
          header: attrs.title && {
            template: attrs.color,
            icon: attrs.icon && {
              tag: 'standard_icon',
              token: attrs.icon,
              color: attrs.iconColor,
            },
            title: {
              tag: 'plain_text',
              content: attrs.title,
            },
            subtitle: attrs.subtitle && {
              tag: 'plain_text',
              content: attrs.subtitle,
            },
          },
          body: {
            direction: attrs.direction,
            padding: attrs.padding,
            horizontal_spacing: attrs.horizontalSpacing,
            horizontal_align: attrs.horizontalAlign,
            vertical_spacing: attrs.verticalSpacing,
            vertical_align: attrs.verticalAlign,
            elements: this.elements = [],
          },
        }
        await this.render(children, true)
      } else if (tag === 'interactive-container') {
        this.flushText()
        const parent = this.elements
        parent.push({
          tag: 'interactive_container',
          disabled: attrs.disabled,
          width: attrs.width,
          height: attrs.height,
          margin: attrs.margin,
          padding: attrs.padding,
          background_style: attrs.backgroundStyle,
          vertical_align: attrs.verticalAlign,
          vertical_spacing: attrs.verticalSpacing,
          horizontal_align: attrs.horizontalAlign,
          horizontal_spacing: attrs.horizontalSpacing,
          direction: attrs.direction,
          has_border: attrs.hasBorder,
          border_color: attrs.borderColor,
          corner_radius: attrs.cornerRadius,
          elements: this.elements = [],
          hover_tips: attrs.hoverTips && {
            tag: 'plain_text',
            content: attrs.hoverTips,
          },
          disabled_tips: attrs.disabledTips && {
            tag: 'plain_text',
            content: attrs.disabledTips,
          },
          behaviors: this.createBehaviors(attrs),
        })
        await this.render(children)
        this.flushText()
        this.elements = parent
      } else if (tag === 'column-set') {
        this.flushText()
        const columns: MessageContent.Card.ColumnElement[] = []
        this.elements.push({
          tag: 'column_set',
          margin: attrs.margin,
          flex_mode: attrs.flexMode,
          horizontal_align: attrs.horizontalAlign,
          horizontal_spacing: attrs.horizontalSpacing,
          background_style: attrs.backgroundStyle,
          columns,
        })
        const parent = this.elements
        for (const child of children) {
          if (child.type !== 'lark:column' && child.type !== 'feishu:column') {
            // throw unexpected?
            continue
          }
          this.elements = []
          await this.render(child.children)
          this.flushText()
          columns.push({
            tag: 'column',
            width: child.attrs.width,
            weight: child.attrs.weight,
            margin: child.attrs.margin,
            padding: child.attrs.padding,
            vertical_align: child.attrs.verticalAlign ?? 'center',
            vertical_spacing: child.attrs.verticalSpacing ?? '0px',
            background_style: child.attrs.backgroundStyle,
            elements: this.elements,
          })
        }
        this.elements = parent
      }
    } else if (type === 'button-group') {
      this.flushText()
      const parent = this.elements
      this.elements = []
      await this.render(children)
      this.flushText()
      parent.push({
        tag: 'column_set',
        margin: attrs.margin,
        flex_mode: attrs.flexMode,
        horizontal_align: attrs.horizontalAlign,
        horizontal_spacing: attrs.horizontalSpacing,
        background_style: attrs.backgroundStyle,
        columns: this.elements.map((element) => ({
          tag: 'column',
          elements: [element],
        })),
      })
      this.elements = parent
    } else {
      await this.render(children)
    }
  }
}

export { LarkMessageEncoder as FeishuMessageEncoder }
