import { Telegram } from './telegram'
import { Twitter } from './twitter'
import { Discord } from './discord'
import { EventEmitter } from 'node:stream'

export const Platforms = {
  telegram: Telegram,
  twitter: Twitter,
  discord: Discord,
}
export type PlatformName = keyof typeof Platforms

export interface Platform extends EventEmitter {
  /**
   * Instantiate the bot with API key. Also set up event handlers.
   * @param key - API key, as String
   */
  setup: (apiKey: string) => Promise<void>
  /** Activate the bot */
  launch: () => Promise<void>
  /** Deactivate the bot */
  stop: () => Promise<void>
  /** Get the bot's ID */
  getBotId: () => string
  /**
   * Send a message to a chat/channel/thread
   * @param chatId - The ID of the chat/channel/thread to send the message to
   * @param message - The message text to send
   * @returns Promise that resolves when message is sent
   */
  sendMessage: (chatId: string, message: string) => Promise<unknown>
  /**
   * Send notification to `platformId` when new deposit received in Chronik API
   * @param platformId - The ID of the platform to send the notification to
   * @param txid - The transaction ID of the deposit
   * @param amount - The amount of the deposit
   * @param balance - The balance of the deposit
   * @returns Promise that resolves when notification is sent
   */
  sendDepositReceived: (
    platformId: string,
    txid: string,
    amount: string,
    balance: string,
  ) => Promise<void>

  on(
    event: 'temporalCommand',
    callback: (data: { command: string; data: string[] }) => void,
  ): this

  emit(
    event: 'temporalCommand',
    { command, data }: { command: string; data: string[] },
  ): boolean
}
