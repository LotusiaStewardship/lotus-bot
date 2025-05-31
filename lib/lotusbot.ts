import { Platforms, PlatformName, Platform } from './platforms'
import config from '../config'
import { WalletManager } from './wallet'
import { Database } from './database'
import { Handler } from './handler'
import {
  Client,
  Connection,
  type SignalDefinition,
  type SearchAttributes,
} from '@temporalio/client'
import { NativeConnection, Worker } from '@temporalio/worker'
import { Activities, LocalActivities } from './temporal'
import type { Temporal } from '../util/types'

// Constants used for logging purposes
const WALLET = 'walletmanager'
const DB = 'prisma'
const MAIN = 'lotusbot'
/** */
export type PlatformInstances = { [platform in PlatformName]?: Platform }
/**
 * Master class
 * Processes all platform commands
 * Handles communication between submodules
 */
export default class LotusBot {
  private prisma: Database
  private wallet: WalletManager
  private handler: Handler
  private bots: PlatformInstances = {}
  private worker!: Worker
  private temporalClient!: Client
  /** Hold enabled platforms */
  private platforms: [name: PlatformName, apiKey: string][] = []
  /**
   * Initialize all submodules
   * Set up required event handlers and gather enabled platforms
   */
  constructor() {
    this.prisma = new Database()
    this.wallet = new WalletManager()
    this.handler = new Handler(this.prisma, this.wallet)
    // @ts-ignore
    this.handler.on('Shutdown', this._shutdown)
    // @ts-ignore
    this.handler.on('DepositSaved', this.handleDepositSaved)
    /** Gather enabled platforms */
    for (const [platform, apiKey] of Object.entries(config.apiKeys)) {
      const name = platform as PlatformName
      if (apiKey) {
        this.platforms.push([name, apiKey])
        this.bots[name] = new Platforms[name](this.handler)
        this.bots[name].on('temporalCommand', this.temporal.sendCommand)
      }
    }
  }
  /** Informational and error logging */
  private _log = (module: string, message: string) =>
    console.log(`${module.toUpperCase()}: ${message}`)
  private _warn = (module: string, message: string) =>
    console.warn(`${module.toUpperCase()}: ${message}`)
  /** Platform notification error logging */
  private _logPlatformNotifyError = (
    platform: PlatformName,
    msg: string,
    error: string,
  ) => this._log(platform, `${msg}: failed to notify user: ${error}`)
  /**
   * Initialize all submodules
   * Set up required event handlers
   */
  init = async () => {
    process.on('SIGINT', this._shutdown)
    process.on('SIGTERM', this._shutdown)
    try {
      /**
       * Initialize Prisma module:
       * - Connect to the database
       */
      try {
        await this.prisma.connect()
        this._log(DB, 'initialized')
      } catch (e: any) {
        throw new Error(`initPrisma: ${e.message}`)
      }
      /**
       * Initialize WalletManager module:
       * - Get all WalletKeys from database
       * - Load all WalletKeys into WalletManager
       */
      try {
        const keys = await this.prisma.getUserWalletKeys()
        await this.wallet.init(
          keys.map(key => {
            const { accountId, userId, hdPrivKey } = key
            const hdPrivKeyBuf = Buffer.from(hdPrivKey)
            return {
              accountId,
              userId,
              hdPrivKey: WalletManager.hdPrivKeyFromBuffer(hdPrivKeyBuf),
            }
          }),
        )
        this._log(WALLET, 'initialized')
      } catch (e: any) {
        throw new Error(`initWalletManager: ${e.message}`)
      }
      /**
       * Initialize all configured bot modules
       * A bot module is considered enabled if the `.env` includes `APIKEY` entry
       */
      for (const [name, apiKey] of this.platforms) {
        try {
          await this.bots[name].setup(apiKey)
          await this.bots[name].launch()
          this._log(name, `initialized`)
        } catch (e: any) {
          throw new Error(`initBot: ${name}: ${e.message}`)
        }
      }
      /**
       * Initialize primary command handler module
       */
      await this.handler.init()
      /**
       * Initialize Temporal worker if all required parameters are configured
       */
      if (
        !Object.values(config.temporal.worker).some(
          v => v === undefined || v === '',
        )
      ) {
        try {
          // set activities object
          const activities: Activities & LocalActivities = {
            ...this.temporalActivities,
            ...this.temporalLocalActivities,
          }
          // create client connection
          this.temporalClient = new Client({
            connection: await Connection.connect({
              address: config.temporal.worker.host,
            }),
            namespace: config.temporal.worker.namespace,
          })
          // create worker
          this.worker = await Worker.create({
            connection: await NativeConnection.connect({
              address: config.temporal.worker.host,
            }),
            namespace: config.temporal.worker.namespace,
            taskQueue: config.temporal.worker.taskQueue,
            activities,
            workflowBundle: {
              codePath: require.resolve('./temporal/workflows'),
            },
          })
          this.worker.run()
        } catch (e) {
          this._warn(MAIN, `Temporal: init: ${e.message}`)
        }
      }
    } catch (e: any) {
      this._log(MAIN, `FATAL: init: ${e.message}`)
      await this._shutdown()
    }
    this._log(MAIN, 'service initialized successfully')
  }
  /** Shutdown all submodules */
  private _shutdown = async () => {
    console.log()
    this._log(MAIN, 'shutting down')
    /** Shutdown enabled platforms */
    for (const [name] of this.platforms) {
      await this.bots[name]?.stop()
      this.bots[name]?.removeAllListeners()
    }
    this.wallet?.closeWsEndpoint()
    await this.prisma?.disconnect()
    try {
      this.worker?.shutdown()
    } catch (e) {
      //
    }
    process.exit(1)
  }
  /**
   * Handle deposit saved event by notifying the user via their platform
   * @param platform - The platform name (telegram, discord, twitter)
   * @param platformId - The user's platform ID
   * @param txid - The transaction ID of the deposit
   * @param amount - The amount deposited in satoshis
   * @param balance - The user's new balance after deposit
   */
  private handleDepositSaved = async ({
    platform,
    platformId,
    txid,
    amount,
    balance,
  }: {
    platform: PlatformName
    platformId: string
    txid: string
    amount: string
    balance: string
  }) => {
    // try to notify user of deposit received
    try {
      await this.bots[platform].sendDepositReceived(
        platformId,
        txid,
        amount,
        balance,
      )
      this._log(
        platform,
        `${platformId}: user notified of deposit received: ${txid}`,
      )
    } catch (e: any) {
      this._logPlatformNotifyError(
        platform,
        'lotusbot.handleDepositSaved',
        e.message,
      )
    }
  }
  /**
   * Temporal-native activities (must be arrow functions)
   */
  temporal = {
    /**
     * Send command to Temporal workflow
     * @param command - The command to send
     * @param data - The data to send with the command
     */
    sendCommand: async ({ command, data }: Temporal.Command) => {
      const workflowType = config.temporal.command.workflow.type
      const workflowId = config.temporal.command.workflow.id
      const signal = config.temporal.command.workflow.signal
      const taskQueue = config.temporal.worker.taskQueue
      try {
        await this.temporalClient.workflow.signalWithStart(workflowType, {
          signal,
          taskQueue,
          workflowId,
          signalArgs: [{ command, data }],
        })
      } catch (e) {
        this._warn(MAIN, `Temporal: sendCommand: ${e.message}`)
      }
    },
  }
  /**
   * Temporal activities (must be arrow functions)
   */
  temporalActivities = {
    /**
     * Activity to send outbound `message` to the specified `chatId` using
     * the corresponding `platform` instance
     * @param param0
     * @returns {Promise<unknown>}
     */
    sendMessage: async ({
      platform,
      chatId,
      message,
    }: Temporal.SendMessageInput): Promise<unknown> => {
      return await this.bots[platform].sendMessage(chatId, message)
    },
    /**
     * Activity to send outbound `Lotus` transaction to the specified `outputs`
     * @param outputs - Array of outputs to send
     * @returns Transaction ID of the broadcasted transaction
     */
    sendLotus: async (outputs: Temporal.SendLotusInput[]): Promise<string> => {
      return await this.handler.temporal.sendLotus(outputs)
    },
    /**
     *
     * @param param0
     * @returns
     */
    startWorkflow: async ({
      taskQueue,
      workflowType,
      workflowId,
      searchAttributes,
      args,
    }: {
      taskQueue: string
      workflowType: string
      workflowId: string
      searchAttributes?: SearchAttributes
      args?: unknown[]
    }) => {
      return await this.temporalClient.workflow.start(workflowType, {
        taskQueue,
        workflowId,
        searchAttributes,
        args,
      })
    },
    /**
     *
     * @param param0
     * @returns
     */
    signalWithStart: async ({
      taskQueue,
      workflowType,
      workflowId,
      args,
      signal,
      signalArgs,
    }: {
      taskQueue: string
      workflowType: string
      workflowId: string
      args?: unknown[]
      signal: string | SignalDefinition
      signalArgs?: unknown[]
    }) => {
      return await this.temporalClient.workflow.signalWithStart(workflowType, {
        taskQueue,
        workflowId,
        args,
        signal,
        signalArgs,
      })
    },
  }
  /**
   * Temporal local activities (must be arrow functions)
   */
  temporalLocalActivities = {
    /**
     *
     * @returns {Promise<string[]>}
     */
    getTelegramChatIds: async (): Promise<string[]> => {
      return process.env.TEMPORAL_NOTIFICATION_CHAT_IDS_TELEGRAM.split(';')
    },
    /**
     *
     * @returns {Promise<string[]>}
     */
    getDiscordChatIds: async (): Promise<string[]> => {
      return process.env.TEMPORAL_NOTIFICATION_CHAT_IDS_DISCORD.split(';')
    },
  }
}
