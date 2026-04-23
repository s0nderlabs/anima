/**
 * iNFT state as seen by the runtime. Phase 4 wires this to the real
 * ERC-7857 contract. Phase 1 provides a stub that fabricates an id from
 * the wallet address so the rest of the runtime can reference identity.
 */
export interface AgentIdentity {
  agentId: string
  iNFT: {
    contract: string | null
    tokenId: string | null
    ownerAddress: string
    network: '0g-mainnet' | '0g-testnet' | 'local-stub'
  }
  agentEoa: string
  subname?: string
}

export interface IdentityProvider {
  current(): Promise<AgentIdentity>
}
