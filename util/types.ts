import type { Address, PrivateKey, Script } from '@abcpros/bitcore-lib-xpi'
import type { ScriptType } from 'chronik-client'
import type { PlatformName } from '../lib/platforms'

export namespace Temporal {
  export type Command = {
    command: string
    data: string[]
  }
  /** Input received from Temporal Workflow, as a single message */
  export type SendMessageInput = {
    platform: PlatformName
    chatId: string
    message: string
  }
  /** Input received from Temporal Workflow, as a single output for a sendLotus activity */
  export type SendLotusInput = {
    scriptPayload: string
    sats: string
  }
}

export namespace Wallet {
  export type Deposit = AccountUtxo & {
    timestamp: Date
    confirmed?: boolean
  }

  export type Give = {
    txid: string
    platform: string
    timestamp: Date
    fromId: string
    toId: string
    value: string
  }

  export type Withdrawal = {
    txid: string
    value: string
    timestamp: Date
    userId: string
  }

  export type Key = {
    signingKey: PrivateKey
    address: Address
    script: Script
    scriptHex: string
    scriptType: ScriptType
    utxos: ParsedUtxo[]
  }

  export type ParsedUtxo = {
    txid: string
    outIdx: number
    value: string
    isCoinbase?: boolean
    blockHeight?: number
  }

  export type AccountUtxo = ParsedUtxo & {
    userId: string
  }
}
