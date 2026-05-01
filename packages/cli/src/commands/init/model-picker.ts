import { cancel, isCancel, select, spinner } from '@clack/prompts'
import { type AnimaNetwork, NETWORK_RPC, OGComputeBrain } from '@s0nderlabs/anima-core'
import { formatEther } from 'viem'
import { shortAddr } from '../../util/format'
import { withSilencedConsole } from '../../util/silence-console'

export interface ModelPick {
  provider: string
  model: string | null
  inputPricePerTokenWei: bigint
  outputPricePerTokenWei: bigint
}

/**
 * Fetch the live 0G Compute provider catalog and prompt the user to pick
 * one. Uses a throwaway privkey for the read-only listService call so no
 * wallet or funds are needed at this stage.
 *
 * Returns `null` if the user cancels, catalog fetch fails, or the list is
 * empty. Caller should treat `null` as "don't block init, set provider=null
 * and let chat.tsx prompt later if needed."
 */
export async function pickBrainModel(opts: {
  network: AnimaNetwork
}): Promise<ModelPick | null> {
  const s = spinner()
  s.start('Fetching live 0G Compute catalog')
  type Svc = {
    provider: string
    model?: string
    serviceType?: string
    inputPrice?: string | bigint
    outputPrice?: string | bigint
  }
  let services: Svc[] = []
  try {
    // Throwaway key — listService is a read; no funds consumed.
    const throwawayKey = `0x${'1'.repeat(64)}`
    services = (await withSilencedConsole(() =>
      OGComputeBrain.listServicesFor({
        privkeyHex: throwawayKey as `0x${string}`,
        rpcUrl: NETWORK_RPC[opts.network],
      }),
    )) as unknown as Svc[]
    s.stop(`Fetched ${services.length} providers`)
  } catch (e) {
    s.stop(`Catalog fetch failed: ${(e as Error).message.slice(0, 120)}`)
    return null
  }
  if (services.length === 0) return null

  const picked = await select({
    message: 'Pick a brain (model)',
    options: services.map(svc => {
      const input = svc.inputPrice ? BigInt(svc.inputPrice) : 0n
      const output = svc.outputPrice ? BigInt(svc.outputPrice) : 0n
      const priceLine =
        input > 0n || output > 0n
          ? `in ${formatEther(input)}/tok · out ${formatEther(output)}/tok`
          : undefined
      return {
        value: svc.provider,
        label: `${svc.model ?? 'unknown'}  ${svc.serviceType ? `[${svc.serviceType}]` : ''}  ${shortAddr(svc.provider)}`,
        hint: priceLine,
      }
    }),
  })
  if (isCancel(picked) || typeof picked !== 'string') {
    cancel('Aborted.')
    return null
  }
  const svc = services.find(s => s.provider === picked)
  if (!svc) return null

  return {
    provider: picked,
    model: svc.model ?? null,
    inputPricePerTokenWei: svc.inputPrice ? BigInt(svc.inputPrice) : 0n,
    outputPricePerTokenWei: svc.outputPrice ? BigInt(svc.outputPrice) : 0n,
  }
}
