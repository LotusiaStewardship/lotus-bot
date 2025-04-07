import { config as dotenv } from 'dotenv'

export type ParsedConfig = {
  apiKeys: {
    telegram: string
    twitter: string
    discord: string
  }
  discord: {
    clientId: string
    guildId: string
  }
  wallet: {
    chronikUrl: string
    explorerUrl: string
    tx: {
      feeRate: number
    }
  }
  dbUrl: string
  temporalWorker: {
    host: string
    namespace: string
    taskQueue: string
  }
}

export class Config {
  constructor(path?: string) {
    dotenv({ path })
  }

  get parsedConfig() {
    return this.parseConfig()
  }

  private parseConfig = (): ParsedConfig => {
    return {
      apiKeys: {
        telegram: process.env.APIKEY_TELEGRAM,
        twitter: process.env.APIKEY_TWITTER,
        discord: process.env.APIKEY_DISCORD,
      },
      discord: {
        clientId: process.env.CLIENTID_DISCORD,
        guildId: process.env.GUILDID_DISCORD,
      },
      wallet: {
        chronikUrl: process.env.WALLET_CHRONIK_URL,
        explorerUrl: process.env.WALLET_EXPLORER_URL,
        tx: {
          feeRate: Number(process.env.TX_FEE_RATE),
        },
      },
      dbUrl: process.env.DATABASE_URL,
      temporalWorker: {
        host: process.env.TEMPORAL_HOST,
        namespace: process.env.TEMPORAL_NAMESPACE,
        taskQueue: process.env.TEMPORAL_TASKQUEUE,
      },
    }
  }
}

const config = new Config('./.env')
export default config.parsedConfig
