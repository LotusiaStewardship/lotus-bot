import {
  Address,
  HDPrivateKey,
  Networks,
  PrivateKey,
  Script,
  Transaction,
} from '@abcpros/bitcore-lib-xpi'
import Mnemonic from '@abcpros/bitcore-mnemonic'
import {
  ChronikClient,
  OutPoint,
  ScriptType,
  SubscribeMsg,
  Tx,
  Utxo,
  WsEndpoint,
} from 'chronik-client'
import config from '../config'
import { WALLET } from '../util/constants'
import { EventEmitter } from 'node:events'
import type { Wallet } from '../util/types'

export interface WalletManager {
  /** Emitted when a `WalletKey` receives an output from a standard transaction */
  on(
    event: 'AddedToMempool' | 'BlockConnected',
    callback: (utxo: Wallet.AccountUtxo) => void,
  ): this
}

export class WalletManager extends EventEmitter {
  // Chronik properties
  private chronik: ChronikClient
  private chronikWs: WsEndpoint
  // Wallet properties
  private keys: { [userId: string]: Wallet.Key } = {}
  /** Array of associated `userId` strings for each `accountId` */
  private accounts: { [accountId: string]: string[] } = {}
  /** Provides all off- and on-chain wallet functionality */
  constructor() {
    super()
    this.chronik = new ChronikClient(config.wallet.chronikUrl)
    this.chronikWs = this.chronik.ws({
      onMessage: this._chronikHandleWsMessage,
    })
  }
  /**
   * - Initialize Chronik WS
   * - load user accounts (keys, UTXOs, WS subscription)
   */
  init = async (
    users: Array<{
      accountId: string
      userId: string
      hdPrivKey: HDPrivateKey
    }>,
  ) => {
    try {
      await this.chronikWs.waitForOpen()
      for (const user of users) {
        await this.loadKey(user)
      }
    } catch (e: any) {
      throw new Error(`WalletManager: init: ${e.message}`)
    }
  }
  /** Unsubscribe from and close Chronik WS */
  closeWsEndpoint = () => {
    for (const userId in this.keys) {
      const { scriptType, scriptHex } = this.keys[userId]
      this.chronikWs.unsubscribe(scriptType, scriptHex)
    }
    this.chronikWs.close()
  }
  /** Get the UTXOs for every `WalletKey` */
  getUtxos = () => {
    const utxos: Wallet.AccountUtxo[] = []
    for (const userIds of Object.values(this.accounts)) {
      userIds.forEach(userId =>
        utxos.push(
          ...this.keys[userId].utxos.map(utxo => {
            return { ...utxo, userId }
          }),
        ),
      )
    }
    return utxos
  }
  getUtxosByUserId = (userId: string) => this.keys[userId].utxos
  /** Get the UTXO balance for the provided `accountId` */
  getAccountBalance = async (accountId: string) => {
    let sats = 0
    try {
      for (const userId of this.accounts[accountId]) {
        // Validate the utxos of this WalletKey; discards invalid utxos
        await this._reconcileUtxos(userId)
        this.keys[userId].utxos.forEach(utxo => (sats += Number(utxo.value)))
      }
      return sats
    } catch (e: any) {
      throw new Error(`getAccountBalance: ${e.message}`)
    }
  }
  /** Return the XAddress of the `WalletKey` of `userId` */
  getXAddress = (userId: string) => this.keys[userId]?.address?.toXAddress()
  getScriptHex = (userId: string) => this.keys[userId]?.scriptHex
  getSigningKey = (userId: string) => this.keys[userId]?.signingKey
  getXAddresses = (accountId: string) => {
    return this.accounts[accountId].map(userId => {
      return this.keys[userId].address.toXAddress()
    })
  }
  /**
   * - load wallet signingKey, script, address
   * - download UTXOs from Chronik and store `ParsedUtxo`s
   * - subscribe to Chronik WS
   */
  loadKey = async ({
    accountId,
    userId,
    hdPrivKey,
  }: {
    accountId: string
    userId: string
    hdPrivKey: HDPrivateKey
  }) => {
    try {
      const signingKey = this._getDerivedSigningKey(hdPrivKey)
      const address = this._getAddressFromSigningKey(signingKey)
      const script = this._getScriptFromAddress(address)
      const scriptType = this._chronikScriptType(address)
      const scriptHex = script.getPublicKeyHash().toString('hex')
      const utxos = await this.fetchUtxos(scriptType, scriptHex)
      const parsedUtxos = utxos.map(utxo => this.toParsedUtxo(utxo))
      this.keys[userId] = {
        signingKey,
        address,
        script,
        scriptHex,
        scriptType,
        utxos: parsedUtxos,
      }
      this.accounts[accountId]
        ? this.accounts[accountId].push(userId)
        : (this.accounts[accountId] = [userId])
      this.chronikWs.subscribe(scriptType, scriptHex)
    } catch (e: any) {
      throw new Error(`loadKey: ${userId}: ${e.message}`)
    }
  }
  /** Update the WalletKey of `userId` with provided `accountId` */
  updateKey = (userId: string, oldAccountId: string, newAccountId: string) => {
    const idx = this.accounts[oldAccountId].findIndex(id => id == userId)
    this.accounts[oldAccountId].splice(idx, 1)
    this.accounts[newAccountId].push(userId)
  }
  /** Process Give/Withdraw tx for the provided `fromUserId` */
  genTx = async (
    type: 'give' | 'withdraw',
    {
      fromAccountId,
      toUserId,
      outAddress,
      sats,
    }: {
      fromAccountId: string
      toUserId?: string
      outAddress?: string
      sats: number
    },
  ) => {
    try {
      switch (type) {
        case 'give':
          // assert(toUserId, "Invalid or null user ID provided");
          const key = this.keys[toUserId]
          return this._genTx(this.accounts[fromAccountId], key.address, sats)
        case 'withdraw':
          // assert(outAddress, "Invalid or null withdrawal address provided");
          return this._genTx(this.accounts[fromAccountId], outAddress, sats)
      }
    } catch (e: any) {
      throw new Error(`genTx: ${e.message}`)
    }
  }
  /** Broadcast the provided tx for the provided userId */
  broadcastTx = async (tx: Transaction) => {
    try {
      const txBuf = tx.toBuffer()
      const broadcasted = await this.chronik.broadcastTx(txBuf)
      return broadcasted.txid
    } catch (e: any) {
      throw new Error(`broadcastTx: ${e.message}`)
    }
  }
  /** Generate transaction for the provided WalletKeys */
  private _genTx = (
    userIds: string[],
    outAddress: string | Address,
    outSats: number,
  ) => {
    const tx = new Transaction()
    const signingKeys: PrivateKey[] = []
    try {
      for (const userId of userIds) {
        const key = this.keys[userId]
        signingKeys.push(key.signingKey)
        for (const utxo of key.utxos) {
          tx.addInput(this._toPKHInput(utxo, key.script))
          if (tx.inputAmount > outSats) {
            break
          }
        }
        // May need to continue adding utxos from other keys
        if (tx.inputAmount < outSats) {
          continue
        }
        tx.feePerByte(config.wallet.tx.feeRate)
        // Set current key's address as change address
        tx.change(key.address)
        const outScript = this._getScriptFromAddress(outAddress)
        const txFee = tx._estimateSize() * config.wallet.tx.feeRate
        tx.addOutput(
          this._toOutput(
            // subtract fee from output amount if required
            outSats + txFee > tx.inputAmount ? outSats - txFee : outSats,
            outScript,
          ),
        )
        tx.sign(signingKeys)
        const verified = tx.verify()
        switch (typeof verified) {
          case 'boolean':
            return tx
          case 'string':
            throw new Error(verified)
        }
      }
    } catch (e: any) {
      throw new Error(`_genTx: ${e.message}`)
    }
  }
  /**
   * Ensure Chronik `AddedToMempool` doesn't corrupt the in-memory UTXO set
   */
  private _isExistingUtxo = (userId: string, utxo: Wallet.ParsedUtxo) => {
    return this.keys[userId].utxos.find(existing => {
      return existing.txid == utxo.txid && existing.outIdx == utxo.outIdx
    })
  }
  /** Fetch UTXOs from Chronik API for provided script data */
  fetchUtxos = async (
    scriptType: ScriptType,
    scriptHex: string,
  ): Promise<Utxo[]> => {
    try {
      const scriptEndpoint = this.chronik.script(scriptType, scriptHex)
      const [result] = await scriptEndpoint.utxos()
      return result?.utxos || []
    } catch (e: any) {
      throw new Error(`fetchUtxos: ${e.message}`)
    }
  }
  /** Remove spent and otherwise invalid UTXOs from user's `WalletKey` */
  private _reconcileUtxos = async (userId: string) => {
    try {
      const utxos = this.keys[userId].utxos
      // const outpoints = utxos.map(utxo => WalletManager.toOutpoint(utxo));
      const result = await this.chronik.validateUtxos(utxos)
      this.keys[userId].utxos = utxos.filter((utxo, i) => {
        switch (result[i].state) {
          case 'NO_SUCH_TX':
          case 'NO_SUCH_OUTPUT':
          case 'SPENT':
            return false
        }
        return true
      })
    } catch (e: any) {
      throw new Error(`_reconcileUtxos: ${e.message}`)
    }
  }
  /**
   * Derive single `PrivateKey` from account's `HDPrivateKey`
   */
  private _getDerivedSigningKey = (hdPrivKey: HDPrivateKey): PrivateKey => {
    try {
      return hdPrivKey
        .deriveChild(WALLET.PURPOSE, true)
        .deriveChild(WALLET.COINTYPE, true)
        .deriveChild(0, true)
        .deriveChild(0)
        .deriveChild(0).privateKey
    } catch (e: any) {
      throw new Error(`getDerivedPrivKey: ${e.message}`)
    }
  }
  /**
   * Convert `PrivateKey` into `Address`
   */
  private _getAddressFromSigningKey = (signingKey: PrivateKey): Address => {
    try {
      return signingKey.toAddress()
    } catch (e: any) {
      throw new Error(`_getAddressFromSigningKey: ${e.message}`)
    }
  }
  /** Convert `Address` string or class to `Script` */
  private _getScriptFromAddress = (address: string | Address): Script => {
    try {
      return Script.fromAddress(address)
    } catch (e: any) {
      throw new Error(`_getScriptFromAddress: ${e.message}`)
    }
  }
  /** Detect and process Chronik WS messages */
  private _chronikHandleWsMessage = async (msg: SubscribeMsg) => {
    try {
      let tx: Tx
      if (msg.type == 'BlockConnected') {
        const block = await this.chronik.block(msg.blockHash)
        tx = block.txs[0]
      }
      if (msg.type == 'AddedToMempool') {
        tx = await this.chronik.tx(msg.txid)
      }
      // don't proceed without tx data
      if (!tx) {
        return
      }
      // process each tx output
      for (let i = 0; i < tx.outputs.length; i++) {
        const output = tx.outputs[i]
        // find userId/key matching output scriptHex
        for (const userIds of Object.values(this.accounts)) {
          const userId = userIds.find(userId => {
            const userScriptHex = this.keys[userId].script.toHex()
            if (output.outputScript == userScriptHex) {
              // New tx has an output that matches one of our wallets
              return true
            }
          })
          if (!userId) {
            continue
          }
          // found our userId/key; save utxo
          const parsedUtxo = {
            txid: tx.txid,
            outIdx: i,
            value: tx.outputs[i].value,
          }
          /**
           * Give transactions generate duplicate Chronik WS messages.
           * This conditional ensures we do not save duplicate UTXOs
           */
          if (this._isExistingUtxo(userId, parsedUtxo)) {
            break
          }
          this.keys[userId].utxos.push(parsedUtxo)
          this.emit(
            msg.type,
            { ...parsedUtxo, userId } as Wallet.AccountUtxo,
            tx.isCoinbase,
          )
          return
        }
      }
    } catch (e: any) {
      throw new Error(`_chronikHandleWsMessage: ${e.message}`)
    }
  }
  /** Return the Chronik `ScriptType` from provided `Address` */
  private _chronikScriptType = (address: Address): ScriptType => {
    switch (true) {
      case address.isPayToPublicKeyHash():
        return 'p2pkh'
      case address.isPayToScriptHash():
        return 'p2sh'
      default:
        return 'other'
    }
  }
  toParsedUtxo = (utxo: Utxo) => {
    const { txid, outIdx } = utxo.outpoint
    const { value } = utxo
    return { txid, outIdx, value }
  }
  /** Create Bitcore-compatible P2PKH `Transaction.Input` */
  private _toPKHInput = (utxo: Wallet.ParsedUtxo, script: Script) => {
    try {
      return new Transaction.Input.PublicKeyHash({
        prevTxId: utxo.txid,
        outputIndex: utxo.outIdx,
        output: this._toOutput(Number(utxo.value), script),
        script,
      })
    } catch (e: any) {
      throw new Error(`_toPKHInput: ${e.message}`)
    }
  }
  /** Create a Bitcore-compatible `Transaction.Output` */
  private _toOutput = (satoshis: number, script: Script) => {
    try {
      return new Transaction.Output({ satoshis, script })
    } catch (e: any) {
      throw new Error(`_toOutput: ${e.message}`)
    }
  }
  /** Generates a new 12-word mnemonic phrase */
  static newMnemonic = () => new Mnemonic() as typeof Mnemonic
  /** Gets `HDPrivateKey` from mnemonic seed buffer */
  static newHDPrivateKey = (mnemonic: typeof Mnemonic) =>
    HDPrivateKey.fromSeed(mnemonic.toSeed())
  /** Instantiate Prisma HDPrivateKey buffer as `HDPrivateKey` */
  static hdPrivKeyFromBuffer = (hdPrivKeyBuf: Buffer) =>
    new HDPrivateKey(hdPrivKeyBuf)
  static toOutpoint = (utxo: Wallet.ParsedUtxo): OutPoint => {
    return {
      txid: utxo.txid,
      outIdx: utxo.outIdx,
    }
  }
  /**
   * Convert Chronik-compatible 20-byte P2PKH to Lotus XAddress format
   * @param scriptPayload
   * @returns
   */
  static toXAddressFromScriptPayload = (scriptPayload: string) =>
    Address.fromPublicKeyHash(
      Buffer.from(scriptPayload, 'hex'),
      Networks.livenet,
    ).toXAddress()
  /**
   * Static method to generate Lotus send transaction. Primarily useful for
   * Temporal Activity Execution
   * @param param0
   * @returns {Transaction}
   */
  static craftSendLotusTransaction = async ({
    outputs,
    totalOutputValue,
    changeAddress,
    utxos,
    inAddress,
    signingKey,
  }: {
    outputs: AsyncIterable<{
      scriptPayload: string
      sats: string
    }>
    totalOutputValue: string
    changeAddress: string
    utxos: Wallet.ParsedUtxo[]
    inAddress: string
    signingKey: PrivateKey
  }): Promise<Transaction> => {
    // set up transaction with base parameters
    const tx = new Transaction()
    tx.feePerByte(config.wallet.tx.feeRate)
    tx.change(changeAddress)
    // input address to script
    const inScript = Script.fromAddress(inAddress)
    // add utxos to inputs until sufficient input amount gathered
    for (const utxo of utxos) {
      tx.addInput(
        new Transaction.Input.PublicKeyHash({
          prevTxId: utxo.txid,
          outputIndex: utxo.outIdx,
          output: new Transaction.Output({
            satoshis: Number(utxo.value),
            script: inScript,
          }),
          script: inScript,
        }),
      )
      // if input amount is greater than total output value, break
      if (tx.inputAmount > Number(totalOutputValue)) {
        break
      }
    }
    // add tx outputs
    for await (const output of outputs) {
      tx.addOutput(
        new Transaction.Output({
          satoshis: Number(output.sats),
          script: Script.fromAddress(
            Address.fromPublicKeyHash(
              Buffer.from(output.scriptPayload, 'hex'),
              Networks.livenet,
            ),
          ),
        }),
      )
    }
    // sign and return tx
    tx.sign(signingKey)
    return tx
  }
  static isValidAddress = (address: string) => Address.isValid(address)
  static WITHDRAW_CHANGE_OUTIDX = 1
  static GIVE_CHANGE_OUTIDX = 1
}
