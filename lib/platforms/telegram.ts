import { setTimeout } from 'node:timers/promises'
import { format } from 'node:util'
import { Context, Telegraf } from 'telegraf'
import { Platform } from '.'
import { BOT } from '../../util/constants'
import { split } from '../../util'
import config from '../../config'
import { Message } from 'telegraf/types'
import { Handler } from '../handler'
import { EventEmitter } from 'node:stream'

const REPLIES_PER_SECOND = 20
const parseGive = (text: string) => {
  const parts = split(text)
  const index = parts.findIndex(part => part.toLowerCase() == '/give')
  return index >= 0 ? parts.slice(index + 1, index + 2).pop() : null
}
const parseWithdraw = (text: string) => {
  const parts = split(text)
  const index = parts.findIndex(part => part.toLowerCase() == '/withdraw')
  return index >= 0 ? parts.slice(index + 1, index + 3) : null
}
const parseLink = (text: string) => {
  const parts = split(text)
  const index = parts.findIndex(part => part.toLowerCase() == '/link')
  return index >= 0 ? parts.slice(index + 1, index + 2).pop() : undefined
}
const parseTemporalCommandContext = (ctx: Context) => {
  const delim = config.temporal.command.delimiter
  const messageText = String((ctx.message as any).text)
  if (!messageText.match(delim)) {
    return false
  }
  return messageText.split(delim)
}
const escape = (text: string) => text.replace(/(_)/g, '\\$1')

export declare interface ITelegram extends Platform {
  on(
    event: 'temporalCommand',
    callback: (data: { command: string; data: string[] }) => void,
  ): this
  emit(
    event: 'temporalCommand',
    data: { command: string; data: string[] },
  ): boolean
}

export class Telegram extends EventEmitter implements ITelegram {
  private client: Telegraf
  private handler: Handler
  private lastReplyTime: number
  constructor(handler: Handler) {
    super()
    this.handler = handler
    this.lastReplyTime = Date.now()
  }

  setup = async (apiKey: string) => {
    this.client = new Telegraf(apiKey)
    this.client.command('give', this.handleGroupMessage)
    this.client.command('balance', this.handleDirectMessage)
    this.client.command('deposit', this.handleDirectMessage)
    this.client.command('withdraw', this.handleDirectMessage)
    this.client.command('link', this.handleDirectMessage)
    this.client.command('backup', this.handleDirectMessage)
    this.client.start(this.handleDirectMessage)
    this.client.on('message', this.handleTemporalCommand)
  }
  launch = async () => {
    this.client.launch()
    // once this promise resolves, bot is active
    // https://github.com/telegraf/telegraf/issues/1749
    await this.client.telegram.getMe()
  }
  stop = async () => {
    this.client?.stop()
  }
  getBotId = () => this.client.botInfo?.id?.toString()
  notifyUser = async (
    platformOrChatId: string | number,
    msg: string,
    replyToMessageId?: number,
  ) => {
    try {
      this.handler.log(
        'telegram',
        `platformOrChatId ${platformOrChatId}: replyToMessageId ${replyToMessageId}: sending notification`,
      )
      await this.client.telegram.sendMessage(platformOrChatId, msg, {
        parse_mode: 'Markdown',
        reply_parameters: {
          message_id: replyToMessageId,
        },
        link_preview_options: {
          is_disabled: true,
        },
      })
    } catch (e: any) {
      this.handler.log(
        `telegram`,
        `${platformOrChatId}: failed to notify user: ${e.message}`,
      )
    }
  }
  sendMessage = async (chatId: string, message: string) => {
    return await this.notifyUser(chatId, message)
  }
  sendDepositReceived = async (
    platformId: string,
    txid: string,
    amount: string,
    balance: string,
  ) => {
    try {
      await setTimeout(this.calcReplyDelay())
      const msg = format(
        BOT.MESSAGE.DEPOSIT_RECV,
        amount,
        balance,
        `${config.wallet.explorerUrl}/tx/${txid}`,
      )
      await this.notifyUser(platformId, msg)
    } catch (e: any) {
      // error is logged in lotusbot.ts
      throw new Error(`sendDepositReceived: ${e.message}`)
    } finally {
      this.lastReplyTime = Date.now()
    }
  }

  private handleBalanceCommand = async (platformId: string) => {
    try {
      const balance = await this.handler.processBalanceCommand(
        'telegram',
        platformId,
      )
      const msg = format(BOT.MESSAGE.BALANCE, balance)
      await this.notifyUser(platformId, msg)
      await setTimeout(this.calcReplyDelay())
    } catch (e: any) {
      this.handler.log(
        'telegram',
        `${platformId}: handleBalanceCommand: ${e.message}`,
      )
    } finally {
      this.lastReplyTime = Date.now()
    }
  }

  private handleDepositCommand = async (platformId: string) => {
    try {
      const address = await this.handler.processDepositCommand(
        'telegram',
        platformId,
      )
      const msg = format(
        BOT.MESSAGE.DEPOSIT,
        address,
        `${config.wallet.explorerUrl}/address/${address}`,
      )
      await setTimeout(this.calcReplyDelay())
      await this.notifyUser(platformId, msg)
    } catch (e: any) {
      this.handler.log(
        'telegram',
        `${platformId}: handleDepositCommand: ${e.message}`,
      )
    } finally {
      this.lastReplyTime = Date.now()
    }
  }

  private handleGiveCommand = async (
    chatId: number,
    replyToMessageId: number,
    fromId: string,
    fromUsername: string,
    toId: string,
    toUsername: string,
    value: string,
    isBotDonation: boolean,
  ) => {
    try {
      const { txid, amount } = await this.handler.processGiveCommand({
        platform: 'telegram',
        chatId,
        fromId,
        fromUsername,
        toId,
        toUsername,
        value,
        isBotDonation,
      })
      const fromUsernameEscaped = escape(fromUsername)
      const toUsernameEscaped = escape(toUsername)
      const reply = isBotDonation ? BOT.MESSAGE.DONATION : BOT.MESSAGE.GIVE
      const msg = format(
        reply,
        fromUsernameEscaped,
        amount,
        toUsernameEscaped,
        `${config.wallet.explorerUrl}/tx/${txid}`,
      )
      await setTimeout(this.calcReplyDelay())
      await this.notifyUser(chatId, msg, replyToMessageId)
    } catch (e: any) {
      this.handler.log(
        'telegram',
        `chatId ${chatId}: fromId ${fromId}: handleGiveCommand: ${e.message}`,
      )
    } finally {
      this.lastReplyTime = Date.now()
    }
  }

  private handleWithdrawCommand = async (
    platformId: string,
    outAmount: string,
    outAddress: string,
  ) => {
    try {
      const result = await this.handler.processWithdrawCommand(
        'telegram',
        platformId,
        outAmount,
        outAddress,
      )
      const msg =
        typeof result == 'string'
          ? format(BOT.MESSAGE.WITHDRAW_FAIL, result)
          : format(
              BOT.MESSAGE.WITHDRAW_OK,
              result.amount,
              `${config.wallet.explorerUrl}/tx/${result.txid}`,
            )
      await setTimeout(this.calcReplyDelay())
      await this.notifyUser(platformId, msg)
    } catch (e: any) {
      this.handler.log(
        'telegram',
        `${platformId}: handleWithdrawCommand: ${e.message}`,
      )
    } finally {
      this.lastReplyTime = Date.now()
    }
  }

  private handleLinkCommand = async (
    platformId: string,
    secret: string | undefined,
  ) => {
    try {
      const result = await this.handler.processLinkCommand(
        'telegram',
        platformId,
        secret,
      )
      await setTimeout(this.calcReplyDelay())
      if (typeof result == 'string') {
        await this.notifyUser(platformId, format(BOT.MESSAGE.LINK_FAIL, result))
        throw new Error(result)
      }
      const msg =
        typeof result.secret == 'string'
          ? format(BOT.MESSAGE.LINK, result.secret)
          : BOT.MESSAGE.LINK_OK
      await this.notifyUser(platformId, msg)
    } catch (e: any) {
      this.handler.log(
        'telegram',
        `${platformId}: handleLinkCommand: ${e.message}`,
      )
    } finally {
      this.lastReplyTime = Date.now()
    }
  }

  private handleBackupCommand = async (platformId: string) => {
    try {
      const mnemonic = await this.handler.processBackupCommand(
        'telegram',
        platformId,
      )
      await setTimeout(this.calcReplyDelay())
      await this.notifyUser(platformId, format(BOT.MESSAGE.BACKUP, mnemonic))
    } catch (e: any) {
      this.handler.log(
        'telegram',
        `${platformId}: handleBackupCommand: ${e.message}`,
      )
    } finally {
      this.lastReplyTime = Date.now()
    }
  }

  private handleDirectMessage = async (ctx: Context) => {
    try {
      if (ctx.chat.type !== 'private') {
        return await ctx.sendMessage(BOT.MESSAGE.ERR_DM_COMMAND, {
          reply_parameters: {
            message_id: ctx.message.message_id,
          },
        })
      }
      const platformId = ctx.message.from.id.toString()
      const messageText = <string>(<any>ctx.message).text
      const command = messageText.split(' ').shift()
      switch (command) {
        case '/deposit':
          return this.handleDepositCommand(platformId)
        case '/withdraw':
          const [outAmount, outAddress] = parseWithdraw(messageText)
          if (!outAmount || !outAddress) {
            return ctx.sendMessage(`Syntax: \`/withdraw amount address\`\r\n`, {
              parse_mode: 'Markdown',
            })
          }
          if (Number(outAmount) <= 0 || isNaN(Number(outAmount))) {
            return ctx.sendMessage(`Invalid amount specified.`, {
              parse_mode: 'Markdown',
            })
          }
          return this.handleWithdrawCommand(platformId, outAmount, outAddress)
        case '/balance':
          return this.handleBalanceCommand(platformId)
        case '/link':
          const secret = parseLink(messageText)
          return this.handleLinkCommand(platformId, secret)
        case '/backup':
          return this.handleBackupCommand(platformId)
        case '/start':
          return ctx.sendMessage(
            `Welcome to my home! ` +
              `I can help you deposit Lotus and give Lotus to other users.\r\n\r\n` +
              `Please see the Menu for available commands.`,
          )
        default:
          return ctx.sendMessage(`Command \`${command}\` is not supported.`, {
            parse_mode: 'Markdown',
          })
      }
    } catch (e: any) {
      throw new Error(`handleDirectMessage: ${e.message}`)
    }
  }

  private handleGroupMessage = async (ctx: Context) => {
    try {
      const replyToMessageId = ctx.message.message_id
      if (ctx.message.chat.type == 'private') {
        return await ctx.sendMessage(BOT.MESSAGE.ERR_NOT_DM_COMMAND, {
          reply_parameters: {
            message_id: replyToMessageId,
          },
        })
      }
      const chatId = ctx.message.chat.id
      const fromId = ctx.message.from.id
      const fromUsername =
        ctx.message.from.username || ctx.message.from.first_name
      const repliedMessage = <Message>(<any>ctx.message).reply_to_message
      // bugfix: don't allow giving to channel messages
      if (repliedMessage?.sender_chat?.type === 'channel') {
        return await ctx.sendMessage(
          BOT.MESSAGE.ERR_GIVE_TO_CHANNEL_DISALLOWED,
          {
            reply_parameters: {
              message_id: replyToMessageId,
            },
          },
        )
      }
      const toId = repliedMessage?.from?.id
      const toUsername =
        repliedMessage?.from?.username || repliedMessage?.from?.first_name
      const messageText = <string>(<any>ctx.message).text
      const command = messageText.split(' ').shift()
      switch (command) {
        case '/give':
          if (!toId || fromId == toId) {
            return await ctx.sendMessage(
              BOT.MESSAGE.ERR_GIVE_MUST_REPLY_TO_USER,
              {
                reply_parameters: {
                  message_id: replyToMessageId,
                },
              },
            )
          }
          // Bot now has its own wallet that is open for donations
          // tell the give command handler this is destined for the bot
          // this ensures that the correct wallet key is used for tx craft
          // the bot IDs are not saved to platform database tables, but may need to be
          let isBotDonation = false
          if (toId == ctx.botInfo.id) {
            isBotDonation = true
            /*
            return await ctx.sendMessage(BOT.MESSAGE.ERR_GIVE_TO_BOT, {
              reply_parameters: {
                message_id: replyToMessageId,
              },
            })
            */
          }
          const messageText = <string>(<any>ctx.message).text
          const amount = parseGive(messageText)
          const amountInt = Number(amount)
          if (isNaN(amountInt) || amountInt <= 0) {
            return await ctx.sendMessage(BOT.MESSAGE.ERR_AMOUNT_INVALID, {
              reply_parameters: {
                message_id: replyToMessageId,
              },
            })
          }
          return this.handleGiveCommand(
            chatId,
            replyToMessageId,
            fromId.toString(),
            fromUsername,
            toId.toString(),
            toUsername,
            amount,
            isBotDonation,
          )
      }
    } catch (e: any) {
      throw new Error(`_handleGroupMessage: ${e.message}`)
    }
  }

  private handleTemporalCommand = async (ctx: Context) => {
    // ignore command if not sent in DM
    if (ctx.message.chat.type !== 'private') {
      return
    }
    const fromId = ctx.message.from.id
    // ignore command if not from approved admin
    if (!config.temporal.command.admins.includes(String(fromId))) {
      return
    }
    // return if array is invalid or if not enough chunks
    const parsed = parseTemporalCommandContext(ctx)
    if (!parsed) {
      return
    }
    const [command, ...data] = parsed
    // ignore command if not allowed
    if (!config.temporal.command.enabled.includes(command)) {
      return
    }
    // send the command and data up the chain
    this.emit('temporalCommand', { command, data })
  }

  private calcReplyDelay = () => {
    const now = Date.now()
    const delay = Math.floor(
      1000 / REPLIES_PER_SECOND - (now - this.lastReplyTime),
    )
    return delay < 0 ? 0 : delay
  }
}
