import { PlatformName } from './platforms'
import * as Util from '../util'
import { BOT, TRANSACTION } from '../util/constants'
import { Wallet } from '../util/types'
import { WalletManager } from './wallet'
import { Database } from './database'
import { EventEmitter } from 'events'
import { asyncCollection } from '../util/functions'

// Constants used for logging purposes
const WALLET = 'walletmanager'
const DB = 'prisma'
const MAIN = 'handler'

const { MIN_OUTPUT_AMOUNT } = TRANSACTION
/**
 * Master class
 * Processes all platform commands
 * Handles communication between submodules
 */
export class Handler extends EventEmitter {
  private prisma: Database
  private wallet: WalletManager

  constructor(prisma: Database, wallet: WalletManager) {
    super()
    this.prisma = prisma
    this.wallet = wallet
    // Add the walletDepositReceived Chronik event callback to the WalletManager
    // This is set as the callback for the 'AddedToMempool' and 'BlockConnected' events
    // `WalletManager` registers this callback when it is instantiated
    this.wallet.walletDepositReceived = this.walletDepositReceived
  }
  /** Informational and error logging */
  log = (module: string, message: string) =>
    console.log(`${module.toUpperCase()}: ${message}`)
  /* Called by any bot module that runs into unrecoverable error */
  shutdown = () => this.emit('Shutdown')
  /** Make sure we process deposits we received while offline */
  init = async () => {
    this.log(MAIN, `checking bot wallet exists`)
    try {
      if (!this.wallet.getXAddress(BOT.USER.userId)) {
        const { accountId, userId } = BOT.USER
        const secret = Util.newUUID()
        const mnemonic = WalletManager.newMnemonic()
        const hdPrivKey = WalletManager.newHDPrivateKey(mnemonic)
        const hdPubKey = hdPrivKey.hdPublicKey
        await this.prisma.saveAccount({
          accountId,
          userId,
          secret,
          mnemonic: mnemonic.toString(),
          hdPrivKey: hdPrivKey.toString(),
          hdPubKey: hdPubKey.toString(),
        })
        await this.wallet.loadKey({ accountId, userId, hdPrivKey })
        this.log(MAIN, `created and loaded bot wallet`)
      }
    } catch (e) {
      throw new Error(`init: ${e.message}`)
    }
    this.log(MAIN, `bot address: ${this.wallet.getXAddress(BOT.USER.userId)}`)
    this.log(MAIN, `reconciling deposits with UTXO set`)
    try {
      const utxos = this.wallet.getUtxos()
      const deposits = await this.prisma.getDeposits()
      const newDeposits = utxos.filter(u => {
        return (
          deposits.findIndex(d => u.txid == d.txid && u.outIdx == d.outIdx) < 0
        )
      })
      for (const deposit of newDeposits) {
        await this.saveDeposit(deposit)
      }
    } catch (e: any) {
      throw new Error(`init: ${e.message}`)
    }
  }
  /**
   * Handle deposit received event from `WalletManager`
   * @param utxo - The deposit UTXO
   */
  walletDepositReceived = async (utxo: Wallet.AccountUtxo) => {
    try {
      await this.saveDeposit(utxo)
    } catch (e: any) {
      this.log(MAIN, `walletDepositReceived: FATAL: ${e.message}`)
      this.shutdown()
    }
  }
  /**
   * Process the `balance` command
   * @param platform - The platform name
   * @param platformId - The platform ID
   * @returns The balance in XPI
   */
  processBalanceCommand = async (
    platform: PlatformName,
    platformId: string,
  ): Promise<string> => {
    const msg = `${platformId}: balance`
    this.log(platform, `${msg}: command received`)
    const { accountId } = await this.validateAndGetIds(platform, platformId)
    const balance = await this.wallet.getAccountBalance(accountId)
    return Util.toXPI(balance)
  }
  /**
   * Process the `deposit` command
   * @param platform - The platform name
   * @param platformId - The platform ID
   * @returns The deposit address
   */
  processDepositCommand = async (
    platform: PlatformName,
    platformId: string,
  ) => {
    const msg = `${platformId}: deposit`
    this.log(platform, `${msg}: command received`)
    const { userId } = await this.validateAndGetIds(platform, platformId)
    return this.wallet.getXAddress(userId)
  }
  /**
   * Process the `give` command
   * @param platform - The platform name
   * @param chatId - The chat ID
   * @param fromId - The from ID
   * @param fromUsername - The from username
   * @param toId - The to ID
   * @param toUsername - The to username
   * @param value - The value
   * @param isBotDonation - Whether the `fromId` is giving to the bot
   */
  processGiveCommand = async ({
    platform,
    chatId,
    fromId,
    fromUsername,
    toId,
    toUsername,
    value,
    isBotDonation,
  }: {
    platform: PlatformName
    chatId?: number
    fromId: string
    fromUsername: string
    toId: string
    toUsername: string
    value: string
    isBotDonation: boolean
  }) => {
    const outSats = Util.toSats(value)
    const msg = `chatId ${chatId}: fromId ${fromId}: give: ${fromUsername} -> ${toId} (${toUsername}): ${outSats} sats`
    this.log(platform, `${msg}: command received`)
    if (outSats < MIN_OUTPUT_AMOUNT) {
      throw new Error(`${msg}: ERROR: minimum required: ${MIN_OUTPUT_AMOUNT}`)
    }
    // Create account for fromId if not exist
    const { accountId: fromAccountId, userId: fromUserId } =
      await this.validateAndGetIds(platform, fromId)
    const balance = await this.wallet.getAccountBalance(fromAccountId)
    if (outSats > balance) {
      throw new Error(`${msg}: ERROR: insufficient balance: ${balance}`)
    }
    // If this is donation to bot, pull that wallet key without db query
    const toUserId = isBotDonation
      ? BOT.USER.userId
      : (await this.validateAndGetIds(platform, toId)).userId
    // Give successful; broadcast tx and save to db
    const tx = await this.wallet.genTx('give', {
      fromAccountId,
      toUserId,
      outSats,
    })
    // save give to database before broadcasting
    try {
      await this.prisma.saveGive({
        txid: tx.txid,
        platform: platform.toLowerCase(),
        timestamp: new Date(),
        fromId: fromUserId,
        toId: toUserId,
        value: outSats.toString(),
      })
    } catch (e: any) {
      throw new Error(`${msg}: ERROR: failed to save give: ${e.message}`)
    }
    this.log(DB, `${msg}: saved to db: ${tx.txid}`)
    // try to broadcast the give tx
    try {
      const txid = await this.wallet.broadcastTx(tx)
      this.log(WALLET, `${msg}: accepted by network: ${txid}`)
    } catch (e: any) {
      await this.prisma.deleteGive(tx.txid)
      throw new Error(`${msg}: ERROR: broadcast failed: ${e.message}`)
    }
    // return broadcasted tx data
    return {
      txid: tx.txid,
      amount: Util.toXPI(tx.outputs[0].satoshis),
    }
  }
  /**
   * Process the `withdraw` command
   * @param platform - The platform name
   * @param platformId - The platform ID
   * @param outAmount - The amount to withdraw
   * @param outAddress - The address to withdraw to
   * @returns The transaction ID and amount, or error message
   */
  processWithdrawCommand = async (
    platform: PlatformName,
    platformId: string,
    outAmount: string,
    outAddress: string,
  ): Promise<Wallet.TxBroadcastResult | string> => {
    const msg = `${platformId}: withdraw: ${outAmount} -> ${outAddress}`
    this.log(platform, `${msg}: command received`)
    const outSats = Util.toSats(outAmount)
    if (!WalletManager.isValidAddress(outAddress)) {
      return `invalid address: \`${outAddress}\``
    } else if (outSats < MIN_OUTPUT_AMOUNT) {
      return `withdraw minimum is ${Util.toXPI(MIN_OUTPUT_AMOUNT)} XPI`
    }
    const { accountId, userId } = await this.validateAndGetIds(
      platform,
      platformId,
    )
    // Get the user's XAddress and check against outAddress
    const addresses = this.wallet.getXAddresses(accountId)
    if (addresses.includes(outAddress)) {
      return `you must withdraw to an external wallet`
    }
    // Get the user's balance and check against outAmount
    const balance = await this.wallet.getAccountBalance(accountId)
    if (outSats > balance) {
      return `insufficient balance: ${outSats} > ${balance}`
    }
    // Generate withdrawal tx
    const tx = await this.wallet.genTx('withdraw', {
      fromAccountId: accountId,
      outAddress,
      outSats,
    })
    // Save the withdrawal to the database before broadcasting
    try {
      await this.prisma.saveWithdrawal({
        txid: tx.txid,
        value: outSats.toString(),
        timestamp: new Date(),
        userId,
      })
    } catch (e: any) {
      throw new Error(`failed to save withdrawal: ${e.message}`)
    }
    this.log(DB, `${msg}: saved: ${tx.txid}`)
    // try to broadcast the withdrawal tx
    try {
      // Broadcast the withdrawal to network
      const txid = await this.wallet.broadcastTx(tx)
      this.log(WALLET, `${msg}: accepted by network: ${txid}`)
      // Get the actual number of sats in the tx output to reply to user
      const outSats = tx.outputs[0].satoshis
      return {
        txid: tx.txid,
        amount: Util.toXPI(outSats),
      }
    } catch (e: any) {
      // If tx broadcast fails, delete the withdrawal database entry
      await this.prisma.deleteWithdrawal(tx.txid)
      throw new Error(`withdrawal broadcast failed: ${e.message}`)
    }
  }
  /**
   * Process the `link` command
   * @param platform - The platform name
   * @param platformId - The platform ID
   * @param secret - The secret
   * @returns The secret or error message
   */
  processLinkCommand = async (
    platform: PlatformName,
    platformId: string,
    secret: string | undefined,
  ): Promise<{ secret: string | undefined } | string> => {
    const msg = `${platformId}: link: ${secret ? '<redacted>' : 'initiate'}`
    this.log(platform, `${msg}: command received`)
    const { accountId, userId } = await this.validateAndGetIds(
      platform,
      platformId,
    )
    switch (typeof secret) {
      /** User provided secret to link account */
      case 'string':
        // Get the accountId associated with the user with the secret
        const linkAccountId = await this.prisma.getAccountIdFromSecret(secret)
        // sanity checks
        if (!linkAccountId) {
          return 'invalid secret provided'
        } else if (linkAccountId == accountId) {
          return 'own secret provided or already linked'
        }
        // try to update the user's accountId
        await this.prisma.updateUserAccountId(userId, linkAccountId)
        this.log(
          platform,
          `${msg}: successfully linked to ${linkAccountId} accountId`,
        )
        // update walletkey with new accountId
        this.wallet.updateKey(userId, accountId, linkAccountId)
        return { secret: undefined }
      /** User wants secret to link account */
      case 'undefined':
        const userSecret = await this.prisma.getUserSecret(platform, platformId)
        // try to send secret to the platform user
        return { secret: userSecret }
    }
  }
  /**
   * Process the `backup` command
   * @param platform - The platform name
   * @param platformId - The platform ID
   * @returns The mnemonic
   */
  processBackupCommand = async (platform: PlatformName, platformId: string) => {
    const msg = `${platformId}: backup`
    this.log(platform, `${msg}: command received`)
    const { userId } = await this.validateAndGetIds(platform, platformId)
    const mnemonic = await this.prisma.getUserMnemonic(userId)
    return mnemonic
  }
  /**
   * Activity function implementations, called by `LotusBot` during Workflow
   * Execution
   *
   * NOTE: must be arrow functions for correct `this` context
   */
  temporal = {
    /**
     * Send Lotus transaction to the specified `outputs`
     * @param outputs - Array of outputs to send, spliced to 99 outputs max
     * @returns Transaction ID of the broadcasted transaction
     */
    sendLotus: async (
      outputs: {
        scriptPayload: string
        sats: string
      }[],
    ): Promise<string> => {
      const walletKey = this.wallet.getWalletKey(BOT.USER.userId)
      const changeAddress = walletKey.address.toXAddress()
      const signingKey = walletKey.signingKey
      const utxos = walletKey.utxos
        // filter out utxos with less than 10_000 XPI
        .filter(({ value }) => Number(value) >= 10_000_000000)
        // sort highest to lowest
        .sort((a, b) => Number(b.value) - Number(a.value))
      const tx = await WalletManager.craftSendLotusTransaction({
        outputs: asyncCollection(outputs), // 99 outputs + 1 change output = 100 outputs max
        totalOutputValue: outputs
          .reduce((acc, { sats }) => acc + Number(sats), 0)
          .toString(),
        changeAddress,
        utxos,
        inAddress: changeAddress,
        signingKey,
      })
      return await this.wallet.broadcastTx(tx)
    },
  }
  /**
   * Validate the `platformId` and `platform`
   * If the account does not exist, it is first created, and the IDs are returned
   * @returns `accountId` and `userId`
   */
  private validateAndGetIds = async (
    platform: PlatformName,
    platformId: string,
  ) => {
    try {
      const isValidUser = await this.prisma.isValidUser(platform, platformId)
      return !isValidUser
        ? await this.saveAccount(platform, platformId)
        : await this.prisma.getIds(platform, platformId)
    } catch (e: any) {
      throw new Error(`handler.validateAndGetIds: ${e.message}`)
    }
  }
  /**
   * - Save platformId/user/account to database
   * - Load new account `WalletKey` into WalletManager
   * - Return `accountId` and `userId` from saved account
   */
  private saveAccount = async (platform: PlatformName, platformId: string) => {
    try {
      const accountId = Util.newUUID()
      const userId = Util.newUUID()
      const secret = Util.newUUID()
      const mnemonic = WalletManager.newMnemonic()
      const hdPrivKey = WalletManager.newHDPrivateKey(mnemonic)
      const hdPubKey = hdPrivKey.hdPublicKey
      await this.prisma.saveAccount({
        accountId,
        userId,
        secret,
        platform,
        platformId,
        mnemonic: mnemonic.toString(),
        hdPrivKey: hdPrivKey.toString(),
        hdPubKey: hdPubKey.toString(),
      })
      await this.wallet.loadKey({ accountId, userId, hdPrivKey })
      this.log(DB, `new account saved: ${accountId}`)
      return { accountId, userId }
    } catch (e: any) {
      throw new Error(`_saveAccount: ${e.message}`)
    }
  }
  /**
   * Save a deposit to the database
   * @param utxo - The deposit to save
   * @returns {Promise<void>}
   */
  private saveDeposit = async (utxo: Wallet.AccountUtxo): Promise<void> => {
    try {
      if (
        // don't notify deposit on give txs
        (await this.prisma.isGiveTx(utxo.txid)) ||
        // Accept a withdrawl as a deposit if the outIdx is not the change Idx
        // Fixes https://github.com/givelotus/lotus-bot/issues/48
        ((await this.prisma.isWithdrawTx(utxo.txid)) &&
          utxo.outIdx == WalletManager.WITHDRAW_CHANGE_OUTIDX) ||
        // ignore bot deposits
        // this does not affect notifications when giving to the bot
        utxo.userId == BOT.USER.userId
      ) {
        return
      }
      const deposit = await this.prisma.saveDeposit({
        ...utxo,
        timestamp: new Date(),
      })
      this.log(DB, `deposit saved: ${JSON.stringify(utxo)}`)
      for (const [platformName, user] of Object.entries(deposit.user)) {
        if (typeof user == 'string' || !user) {
          continue
        }
        const { accountId } = deposit.user
        const balance = await this.wallet.getAccountBalance(accountId)
        // @ts-ignore
        this.emit('DepositSaved', {
          platform: platformName as PlatformName,
          platformId: user.id,
          txid: utxo.txid,
          amount: Util.toXPI(utxo.value),
          balance: Util.toXPI(balance),
          isCoinbase: utxo.isCoinbase,
          blockHeight: utxo.blockHeight,
        })
        return
      }
    } catch (e: any) {
      throw new Error(`handler.saveDeposit: ${e.message}`)
    }
  }
}
