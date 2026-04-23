import { placeholderAgentId } from '../paths'
import type { AgentIdentity, IdentityProvider } from './types'

/**
 * Local stub identity provider. Fabricates an agent id from the wallet
 * address so runtime + memory have something stable to key on before the
 * iNFT is minted (phase 4).
 */
export class StubIdentity implements IdentityProvider {
  constructor(
    private readonly ownerAddress: string,
    private readonly agentEoa: string,
    private readonly subname?: string,
  ) {}

  async current(): Promise<AgentIdentity> {
    return {
      agentId: placeholderAgentId(this.agentEoa),
      iNFT: {
        contract: null,
        tokenId: null,
        ownerAddress: this.ownerAddress,
        network: 'local-stub',
      },
      agentEoa: this.agentEoa,
      subname: this.subname,
    }
  }
}
