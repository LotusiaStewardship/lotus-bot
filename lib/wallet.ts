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
  Tx as ChronikTx,
  Utxo,
  UtxoState,
  WsEndpoint,
} from 'chronik-client'
import config from '../config'
import { WALLET } from '../util/constants'
import type { Wallet } from '../util/types'
import { asyncCollection } from '../util/functions'
/** A map of `WalletKey` instances, keyed by `userId` */
type WalletMap = Map<string, WalletKey>
/**
 * Static methods for the `WalletKey` and `WalletManager` classes
 */
export class WalletTools {
  /**
   * Get the Bitcore `Script` for the provided `Address`
   * @param address - The `Address` to get the script for, in string or `Address` format
   * @returns The Bitcore `Script`
   */
  static getScriptFromAddress = (address: string | Address): Script => {
    try {
      return Script.fromAddress(address)
    } catch (e: any) {
      throw new Error(`getScriptFromAddress: ${e.message}`)
    }
  }
  /**
   * Get the Bitcore `PrivateKey` from the provided `HDPrivateKey`
   * @param hdPrivKey - The `HDPrivateKey` from which to derive the `PrivateKey`
   * @returns The Bitcore `PrivateKey`
   */
  static getDerivedSigningKey = (hdPrivKey: HDPrivateKey): PrivateKey => {
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
   * Get the Bitcore `Address` for the provided `PrivateKey`
   * @param signingKey - The `PrivateKey` to get the address for
   * @returns The Bitcore `Address`
   */
  static getAddressFromSigningKey = (signingKey: PrivateKey): Address => {
    try {
      return signingKey.toAddress()
    } catch (e: any) {
      throw new Error(`getAddressFromSigningKey: ${e.message}`)
    }
  }
  /**
   * Get the Chronik script type for the provided `Address`
   * @param address - The `Address` to get the script type for
   * @returns The Chronik script type
   */
  static getChronikScriptType = (address: string | Address): ScriptType => {
    // Convert string to Address if needed
    address =
      typeof address === 'string' ? Address.fromString(address) : address
    switch (true) {
      case address.isPayToPublicKeyHash():
        return 'p2pkh'
      case address.isPayToScriptHash():
        return 'p2sh'
      default:
        return 'other'
    }
  }
  /**
   * Convert a Chronik UTXO to a Bitcore-compatible `ParsedUtxo`
   * @param utxo - The Chronik UTXO to convert
   * @returns The Bitcore-compatible `ParsedUtxo`
   */
  static toParsedUtxo = (utxo: Utxo) => {
    const { txid, outIdx } = utxo.outpoint
    const { value } = utxo
    return { txid, outIdx, value }
  }
  /** Create Bitcore-compatible P2PKH `Transaction.Input` */
  static toPKHInput = (utxo: Wallet.ParsedUtxo, script: Script) => {
    try {
      return new Transaction.Input.PublicKeyHash({
        prevTxId: utxo.txid,
        outputIndex: utxo.outIdx,
        output: this.toOutput(Number(utxo.value), script),
        script,
      })
    } catch (e: any) {
      throw new Error(`_toPKHInput: ${e.message}`)
    }
  }
  /** Create a Bitcore-compatible `Transaction.Output` */
  static toOutput = (satoshis: number, script: Script) => {
    try {
      return new Transaction.Output({ satoshis, script })
    } catch (e: any) {
      throw new Error(`_toOutput: ${e.message}`)
    }
  }
}
/**
 * A `WalletKey` is a single Bitcore `PrivateKey` with associated `Address`,
 * `Script`, and `ScriptType`. Each platform user has their own `WalletKey`.
 */
class WalletKey {
  /** The unique identifier for this wallet account */
  public accountId: string
  /** The unique identifier for the user associated with this wallet */
  public userId: string
  /** This Chronik client instance is only for managing UTXOs in this `WalletKey` */
  public chronik: ChronikClient
  /** This Chronik WS endpoint is only for managing UTXOs in this `WalletKey` */
  public chronikWs: WsEndpoint
  /** The private key used for signing transactions */
  public signingKey: PrivateKey
  /** The public address derived from the signing key */
  public address: Address
  /** The locking script that controls spending from this address */
  public script: Script
  /** The type of script (e.g. p2pkh) as used by Chronik */
  public scriptType: ScriptType
  /** The full P2PKH script as a hex string */
  public scriptHex: string
  /** The hex-encoded public key hash used in the script */
  public scriptPayload: string
  /** The UTXO cache for this `WalletKey` */
  public utxos: Wallet.ParsedUtxo[] = []
  /**
   * Creates a new `WalletKey` instance
   * @param accountId - The unique identifier for this wallet account
   * @param hdPrivKey - The `HDPrivateKey` used to derive the signing key
   */
  constructor(
    accountId: string,
    userId: string,
    hdPrivKey: HDPrivateKey,
    chronik: ChronikClient,
    chronikWs: WsEndpoint,
  ) {
    this.accountId = accountId
    this.userId = userId
    this.signingKey = WalletTools.getDerivedSigningKey(hdPrivKey)
    this.address = WalletTools.getAddressFromSigningKey(this.signingKey)
    this.script = WalletTools.getScriptFromAddress(this.address)
    this.scriptType = WalletTools.getChronikScriptType(this.address)
    this.scriptHex = this.script.toHex()
    this.scriptPayload = this.script.getData().toString('hex')
    this.chronik = chronik
    this.chronikWs = chronikWs
  }
  /** Initialize the Chronik client and WS endpoint */
  public async init() {
    const utxos = await this.fetchUtxos()
    this.utxos = utxos.map(utxo => WalletTools.toParsedUtxo(utxo))
  }
  /** Get the balance of the `WalletKey` by adding the value of all cached, in-memory UTXOs */
  public async getBalance() {
    this.utxos = await this.validateUtxos(this.utxos ?? [])
    return this.utxos.reduce((balance, utxo) => balance + Number(utxo.value), 0)
  }
  /**
   * Fetch UTXOs from Chronik API for `WalletKey` script data
   * @returns The UTXOs from Chronik
   */
  async fetchUtxos(): Promise<Utxo[]> {
    try {
      const scriptEndpoint = this.chronik.script(
        this.scriptType,
        this.scriptPayload,
      )
      const [result] = await scriptEndpoint.utxos()
      return result?.utxos || []
    } catch (e: any) {
      throw new Error(`fetchUtxos: ${e.message}`)
    }
  }
  /**
   * Validate UTXOs against Chronik API
   * @param utxos - The UTXOs to validate
   * @returns The validated UTXOs
   */
  private async validateUtxos(utxos: Wallet.ParsedUtxo[]) {
    let result: UtxoState[]
    try {
      result = await this.chronik.validateUtxos(utxos)
    } catch (e: any) {
      throw new Error(`reconcileUtxos: ${e.message}`)
    }
    const validatedUtxos: Wallet.ParsedUtxo[] = []
    let i = 0
    for await (const utxo of asyncCollection(utxos)) {
      switch (result[i].state) {
        case 'UNSPENT':
          validatedUtxos.push(utxo)
      }
      i++
    }
    return validatedUtxos
  }
}
/**
 * The `WalletManager` is responsible for managing all `WalletKey` instances
 * and their associated UTXOs. It is also responsible for handling Chronik WS
 * messages and updating the in-memory UTXO set.
 *
 * The `WalletManager` is responsible for:
 * - Initializing Chronik WS
 * - Loading user accounts (keys, UTXOs, WS subscription)
 */
export class WalletManager {
  /** The Chronik client instance */
  private chronik: ChronikClient
  /** The Chronik WS endpoint */
  private chronikWs: WsEndpoint
  /** A map of `WalletKey` instances, keyed by `userId` */
  private wallets: WalletMap = new Map()
  /** A map of `accountId`s to `userId`s */
  private accounts: { [accountId: string]: string[] } = {}
  /** The callback to execute when a deposit is received */
  public walletDepositReceived: (utxo: Wallet.AccountUtxo) => Promise<void>
  /**
   * @property chronik - The Chronik client instance
   * @property chronikWs - The Chronik WS endpoint, hooked to the `chronikHandleWsMessage` method that is used by all `WalletKey` instances
   */
  constructor() {
    this.chronik = new ChronikClient(config.wallet.chronikUrl)
    this.chronikWs = this.chronik.ws({
      onMessage: this.chronikHandleWsMessage,
      onError: async e => await this.chronikWs.waitForOpen(),
      onEnd: async e => await this.chronikWs.waitForOpen(),
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
    for (const [_userId, walletKey] of this.wallets) {
      this.chronikWs.unsubscribe(walletKey.scriptType, walletKey.scriptPayload)
    }
    this.chronikWs.close()
  }
  /** Get the UTXOs for every `WalletKey` */
  getUtxos = (): Wallet.AccountUtxo[] => {
    const utxos: Wallet.AccountUtxo[] = []
    for (const [userId, walletKey] of this.wallets) {
      utxos.push(
        ...walletKey.utxos.map(utxo => {
          return { ...utxo, userId }
        }),
      )
    }
    return utxos
  }
  /** Get the `WalletKey` for the provided `userId` */
  getWalletKey = (userId: string) => this.wallets.get(userId)
  /** Get the UTXOs for the provided `userId` */
  getUtxosByUserId = (userId: string) => this.wallets.get(userId)?.utxos
  /** Get the UTXO balance for the provided `accountId` */
  getAccountBalance = async (accountId: string) => {
    let balance = 0
    for (const userId of this.accounts[accountId]) {
      const walletKey = this.wallets.get(userId)
      balance += await walletKey.getBalance()
    }
    return balance
  }
  /** Return the XAddress of the `WalletKey` of `userId` */
  getXAddress = (userId: string) =>
    this.wallets.get(userId)?.address?.toXAddress()
  getScriptPayload = (userId: string) => this.wallets.get(userId)?.scriptPayload
  getSigningKey = (userId: string) => this.wallets.get(userId)?.signingKey
  getXAddresses = (accountId: string) => {
    return this.accounts[accountId].map(userId => {
      return this.wallets.get(userId)?.address.toXAddress()
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
      this.accounts[accountId]?.push(userId) ||
        (this.accounts[accountId] = [userId])
      // Set up new wallet and subscribe to Chronik WS
      const walletKey = new WalletKey(
        accountId,
        userId,
        hdPrivKey,
        this.chronik,
        this.chronikWs,
      )
      await walletKey.init()
      this.wallets.set(userId, walletKey)
      // set the Chronik WS message handler for this wallet
      this.chronikWs.subscribe(walletKey.scriptType, walletKey.scriptPayload)
    } catch (e: any) {
      throw new Error(`loadKey: ${userId}: ${e.message}`)
    }
  }
  /** Update the WalletKey of `userId` with provided `accountId` */
  updateKey = (userId: string, oldAccountId: string, newAccountId: string) => {
    const idx = this.accounts[oldAccountId].findIndex(id => id == userId)
    this.accounts[oldAccountId].splice(idx, 1)
    this.accounts[newAccountId].push(userId)
    this.wallets.get(userId)!.accountId = newAccountId
  }
  /** Process Give/Withdraw tx for the provided `fromUserId` */
  genTx = async (
    type: 'give' | 'withdraw',
    {
      fromAccountId,
      toUserId,
      outAddress,
      outSats,
    }: {
      fromAccountId: string
      toUserId?: string
      outAddress?: string
      outSats: number
    },
  ) => {
    const tx = new Transaction()
    const signingKeys: PrivateKey[] = []
    // wallets used to fund the transaction
    const userIds = this.accounts[fromAccountId]
    try {
      for (const userId of userIds) {
        const wallet = this.wallets.get(userId)
        signingKeys.push(wallet.signingKey)
        for (const utxo of wallet.utxos) {
          tx.addInput(WalletTools.toPKHInput(utxo, wallet.script))
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
        tx.change(wallet.address)
        // Set up output script
        let outScript: Script
        switch (type) {
          case 'give':
            outScript = this.wallets.get(toUserId)?.script
            break
          case 'withdraw':
            outScript = WalletTools.getScriptFromAddress(outAddress)
            break
        }
        // add appropriate output with tx fee subtracted if required
        const txFee = tx._estimateSize() * config.wallet.tx.feeRate
        tx.addOutput(
          WalletTools.toOutput(
            // subtract fee from output amount if required
            outSats + txFee > tx.inputAmount ? outSats - txFee : outSats,
            outScript,
          ),
        )
        // sign and verify tx
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
        const wallet = this.wallets.get(userId)
        signingKeys.push(wallet.signingKey)
        for (const utxo of wallet.utxos) {
          tx.addInput(WalletTools.toPKHInput(utxo, wallet.script))
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
        tx.change(wallet.address)
        const outScript = WalletTools.getScriptFromAddress(outAddress)
        const txFee = tx._estimateSize() * config.wallet.tx.feeRate
        tx.addOutput(
          WalletTools.toOutput(
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
  private isExistingUtxo = (userId: string, utxo: Wallet.ParsedUtxo) => {
    const utxos = this.wallets.get(userId)?.utxos
    return utxos.length > 0
      ? utxos.some(
          existing =>
            existing.txid == utxo.txid && existing.outIdx == utxo.outIdx,
        )
      : false
  }
  /** Detect and process Chronik WS messages */
  chronikHandleWsMessage = async (msg: SubscribeMsg) => {
    try {
      let tx: ChronikTx
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
      let i = -1
      for await (const output of asyncCollection(tx.outputs)) {
        // increment output index
        // if first output, this will value start at 0
        i++
        // find userId/key matching output scriptHex
        for await (const userIds of asyncCollection(
          Object.values(this.accounts),
        )) {
          const userId = userIds.find(
            userId =>
              this.wallets.get(userId)?.scriptHex == output.outputScript,
          )
          if (!userId) {
            continue
          }
          // found our userId/key; save utxo
          const parsedUtxo = {
            txid: tx.txid,
            outIdx: i,
            value: output.value,
          } as Wallet.ParsedUtxo
          // add metadata for coinbase tx if needed
          if (tx.isCoinbase) {
            parsedUtxo.isCoinbase = true
            parsedUtxo.blockHeight = tx.block?.height
          }
          /**
           * Give transactions generate duplicate Chronik WS messages.
           * This conditional ensures we do not save duplicate UTXOs
           */
          if (this.isExistingUtxo(userId, parsedUtxo)) {
            break
          }
          // push the utxo to the wallet's utxo set
          this.wallets.get(userId)!.utxos.push(parsedUtxo)
          // do not emit change outputs as deposits
          if (WalletManager.isChangeOutput(i, tx.outputs)) {
            return
          }
          await this.walletDepositReceived({
            ...parsedUtxo,
            userId,
          } as Wallet.AccountUtxo)
          return
        }
      }
    } catch (e: any) {
      throw new Error(`_chronikHandleWsMessage: ${e.message}`)
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
    // TODO: add check for tx size (max is 100KB)
    // sign and return tx
    tx.sign(signingKey)
    return tx
  }
  static isValidAddress = (address: string) => Address.isValid(address)
  /**
   * Assumes that the last output is the change output. Used in Chronik WS message handling.
   * @param outIdx - the index of the output to check
   * @param outputs - the outputs of the transaction, in Chronik format
   * @returns true if the output is the change output, false otherwise.
   */
  static isChangeOutput = (outIdx: number, outputs: ChronikTx['outputs']) =>
    outIdx == outputs.length - 1
  static WITHDRAW_CHANGE_OUTIDX = 1
  static GIVE_CHANGE_OUTIDX = 1
}
