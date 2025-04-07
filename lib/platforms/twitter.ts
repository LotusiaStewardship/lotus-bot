import { Platform } from '.'

export type TwitterMessage = {}

export class Twitter implements Platform {
  setup = async () => {}
  launch = async () => {}
  stop = async () => {}
  getBotId: () => string
  sendMessage: (chatOrGuildId: string, message: string) => Promise<unknown>
  sendBalanceReply: (platformId: string, balance: string) => Promise<void>
  sendDepositReply: (platformId: string, address: string) => Promise<void>
  sendDepositReceived: (
    platformId: string,
    txid: string,
    amount: string,
    balance: string,
  ) => Promise<void>
  sendDepositConfirmed: (
    platformId: string,
    txid: string,
    amount: string,
    balance: string,
  ) => Promise<void>
  sendGiveReply: (
    chatId: string,
    replyToMessageId: number,
    fromUsername: string,
    toUsername: string,
    txid: string,
    amount: string,
  ) => Promise<void>
  sendWithdrawReply: (
    platformId: string,
    {
      txid,
      amount,
      error,
    }: {
      txid?: string
      amount?: string
      error?: string
    },
  ) => Promise<void>
  sendLinkReply = async (
    platformId: string,
    { error, secret }: { error?: string; secret?: string },
  ) => {}
  sendBackupReply: (platformId: string, mnemonic: string) => Promise<void>
}
