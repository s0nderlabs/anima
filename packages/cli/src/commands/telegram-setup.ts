import { cancel, intro, isCancel, note, outro, password, spinner, text } from '@clack/prompts'
import { iNFTAgentId } from '@s0nderlabs/anima-core'
import { type Address, getAddress } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { writeConfigTs } from '../config/render'
import {
  fetchBotInfo,
  looksLikeBotToken,
  parseAllowedUserIds,
  saveTelegramSecrets,
  telegramSecretsExist,
} from '../util/telegram-secrets'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export async function runTelegramSetup(): Promise<void> {
  intro('anima telegram setup')

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

  const agentAddress = getAddress(config.identity.agent) as Address
  const inftContract = getAddress(config.identity.iNFT.contract) as Address
  const tokenId = BigInt(config.identity.iNFT.tokenId)
  const agentId = iNFTAgentId({ contractAddress: inftContract, tokenId })

  if (telegramSecretsExist(agentId)) {
    note(
      'An encrypted telegram-secrets blob already exists for this agent.\nThis wizard will overwrite it. Run `anima telegram remove` first if you want to keep the old one.',
      'existing config',
    )
  }

  const tokenRaw = (await password({
    message: 'Bot token from @BotFather',
    validate: v => {
      if (!v) return 'Required.'
      if (!looksLikeBotToken(v))
        return 'Looks malformed. Expected `<id>:<secret>` from @BotFather, e.g. 1234567890:AABBCC...'
      return undefined
    },
  })) as string | symbol
  if (isCancel(tokenRaw)) {
    cancel('Aborted.')
    return
  }
  const botToken = (tokenRaw as string).trim()

  const sValidate = spinner()
  sValidate.start('Validating token via api.telegram.org/getMe')
  let botInfo: Awaited<ReturnType<typeof fetchBotInfo>>
  try {
    botInfo = await fetchBotInfo(botToken)
    sValidate.stop(`bot ok: @${botInfo.username} (id ${botInfo.id})`)
  } catch (e) {
    sValidate.stop(`token rejected: ${(e as Error).message.slice(0, 200)}`)
    cancel('Bad token. Re-issue via /token in @BotFather and re-run setup.')
    return
  }

  const allowedRaw = (await text({
    message: 'Allowed Telegram user IDs (comma-separated; blank = pairing-only mode, see below)',
    placeholder: '123456789, 987654321',
    defaultValue: '',
    validate: v => {
      if (!v) return undefined
      const parsed = parseAllowedUserIds(v)
      if (!parsed.ok) return parsed.reason
      return undefined
    },
  })) as string | symbol
  if (isCancel(allowedRaw)) {
    cancel('Aborted.')
    return
  }
  const parsedAllowed = parseAllowedUserIds(typeof allowedRaw === 'string' ? allowedRaw : '')
  if (!parsedAllowed.ok) {
    cancel(`bad allowed list: ${parsedAllowed.reason}`)
    return
  }
  const allowedUserIds = parsedAllowed.ids

  if (allowedUserIds.length === 0) {
    note(
      `Empty allow-list. Default-deny is on: any unknown user who DMs @${botInfo.username}\nwill receive a one-time pairing code. Approve them out-of-band:\n  anima pairing approve telegram <CODE>\nTo skip pairing entirely, re-run setup and add your numeric id\n(get it from @userinfobot).`,
      'pairing mode',
    )
  }

  const operator = await loadOrPickOperatorSigner({
    network: config.network,
    hint: config.operator,
  })
  if (!operator) {
    cancel('No operator wallet available; cannot encrypt secrets.')
    return
  }

  const sSave = spinner()
  sSave.start('Encrypting + saving telegram secrets locally')
  try {
    await saveTelegramSecrets({
      signer: operator,
      agentAddress,
      agentId,
      plaintext: {
        botToken,
        botUsername: botInfo.username,
        botId: botInfo.id,
        allowedUserIds,
      },
    })
    sSave.stop(`saved → ~/.anima/agents/${agentId}/telegram-secrets.encrypted`)
  } catch (e) {
    sSave.stop(`save failed: ${(e as Error).message.slice(0, 200)}`)
    await operator.close?.()
    return
  } finally {
    await operator.close?.()
  }

  const plugins = Array.from(new Set([...(config.plugins ?? []), 'telegram' as const]))
  if (plugins.length !== (config.plugins ?? []).length) {
    const updated = { ...config, plugins }
    await writeConfigTs(configPath, updated, { subname: config.subname })
  }

  const isSandbox = config.deployTarget === 'sandbox' && config.sandbox?.endpoint
  if (isSandbox) {
    note(
      'Sandbox-mode agent: secrets are stored locally now, but the harness inside\nthe Daytona container needs them too. Run `anima telegram push` (coming in B7)\nor re-run `anima upgrade` once telegram-on-sandbox lands to ship them.',
      'sandbox handoff pending',
    )
  } else {
    note(
      `Open https://t.me/${botInfo.username} in Telegram and send /start.\nThen run \`anima\` to bring the agent online; the bot will reply once your\nfirst DM arrives.`,
      'next step',
    )
  }

  outro(`telegram setup complete (@${botInfo.username})`)
}
