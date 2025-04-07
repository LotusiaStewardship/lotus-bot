import LotusBot from './lotusbot'
type LotusBotActivities = typeof LotusBot.prototype.temporal
/** Define the LotusBot activities that are to be registered with the Worker */
export interface WorkerActivities {
  sendMessage: LotusBotActivities['sendMessage']
}
