import { cancel, confirm, intro, isCancel, note, outro } from '@clack/prompts'
import { iNFTAgentId } from '@s0nderlabs/anima-core'
import { getAddress } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import {
  removeTelegramSecrets,
  telegramSecretsExist,
  telegramSecretsPath,
} from '../util/telegram-secrets'

export interface TelegramRemoveOpts {
  yes?: boolean
}

export async function runTelegramRemove(opts: TelegramRemoveOpts = {}): Promise<void> {
  intro('anima telegram remove')

  const loaded = await findAndLoadConfig()
  if (!loaded) {
    cancel('No anima.config.ts found. Run `anima init` first.')
    return
  }
  const { config, path: configPath } = loaded
  if (!config.identity.iNFT || !config.identity.agent) {
    cancel('Config has no iNFT or agent. Run `anima init` first.')
    return
  }

  const inftContract = getAddress(config.identity.iNFT.contract)
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentId = iNFTAgentId({ contractAddress: inftContract, tokenId })

  if (!telegramSecretsExist(agentId)) {
    note('Nothing to remove.')
    outro('not configured')
    return
  }

  if (!opts.yes) {
    const ok = (await confirm({
      message: `Delete encrypted telegram-secrets for ${agentId}?`,
      initialValue: false,
    })) as boolean | symbol
    if (isCancel(ok) || !ok) {
      cancel('Aborted.')
      return
    }
  }

  await removeTelegramSecrets(agentId)

  const plugins = (config.plugins ?? []).filter(p => p !== 'telegram')
  if (plugins.length !== (config.plugins ?? []).length) {
    const updated = { ...config, plugins }
    await writeConfigTs(configPath, updated, { subname: config.subname })
  }

  note(
    `Local blob deleted: ${telegramSecretsPath(agentId)}\nThe bot token at @BotFather is STILL VALID. To fully revoke, run /token in\n@BotFather and pick "Revoke" for this bot.`,
    'reminder',
  )

  outro('telegram removed')
}
