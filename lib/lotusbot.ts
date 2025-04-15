import { Platforms, PlatformName, Platform } from './platforms'
import config from '../config'
import { WalletManager } from './wallet'
import { Database } from './database'
import { Handler } from './handler'
import { Client } from '@temporalio/client'
import { NativeConnection, Worker } from '@temporalio/worker'
import { Activities, LocalActivities } from './temporal'

namespace Temporal {
  export type Command = {
    command: string
    data: string[]
  }
}
type SendMessageInput = {
  platform: PlatformName
  chatId: string
  message: string
}

type SendLotusInput = {
  scriptPayload: string
  sats: string
}

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

  constructor() {
    this.prisma = new Database()
    this.wallet = new WalletManager()
    this.handler = new Handler(this.prisma, this.wallet)
    // @ts-ignore
    this.handler.on('Shutdown', this._shutdown)
    // @ts-ignore
    this.handler.on('DepositSaved', this._depositSaved)
    /** Gather enabled platforms */
    for (const [platform, apiKey] of Object.entries(config.apiKeys)) {
      const name = platform as PlatformName
      if (apiKey) {
        this.platforms.push([name, apiKey])
        this.bots[name] = new Platforms[name](this.handler)
        this.bots[name].on('temporalCommand', this.temporal.signalWorkflow)
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

  private _depositSaved = async ({
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
      this._logPlatformNotifyError(platform, '_depositSaved', e.message)
    }
  }
  temporal = {
    /**
     *
     * @param param0
     * @returns
     */
    signalWorkflow: async ({ command, data }: Temporal.Command) => {
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
        this._warn(MAIN, `Temporal: signalWorkflow: ${e.message}`)
      }
    },
  }
  /**
   * Temporal activities (must be arrow functions)
   */
  temporalActivities = {
    /**
     *
     * @param param0
     * @returns
     */
    sendMessage: async ({ platform, chatId, message }: SendMessageInput) => {
      await this.bots[platform].sendMessage(chatId, message)
    },

    sendLotus: async ({ scriptPayload, sats }: SendLotusInput) => {
      // TODO: implement this
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
