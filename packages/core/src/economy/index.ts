/**
 * v0.21.0 economy module — agent-self-funding mechanisms.
 *
 * Currently houses the AutoTopupManager which lets an anima agent pay its
 * own compute bills out of its EOA without operator intervention.
 */

export {
  AutoTopupManager,
  type AutoTopupOpts,
  type AutoTopupDeps,
  type AutoTopupEvent,
  type AutoTopupEventKind,
  type BrokerLedgerLike,
  type PublicClientLike,
} from './auto-topup'
