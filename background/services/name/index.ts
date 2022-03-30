import { DomainName, HexString, UNIXTime } from "../../types"
import { EVMNetwork } from "../../networks"
import { normalizeEVMAddress, sameEVMAddress } from "../../lib/utils"
import { ETHEREUM } from "../../constants/networks"
import { getTokenMetadata } from "../../lib/erc721"

import { ServiceCreatorFunction, ServiceLifecycleEvents } from "../types"
import BaseService from "../base"
import ChainService from "../chain"
import logger from "../../lib/logger"
import { SECOND } from "../../constants"
import PreferenceService from "../preferences"

import {
  addressBookResolverFor,
  ensAddressResolverFor,
  knownContractResolverFor,
  NameResolverFunction,
  NameResolverSystem,
  ResolvedAddressRecord,
  ResolvedAvatarRecord,
  ResolvedNameRecord,
} from "./utils"

export { NameResolverSystem }

type Events = ServiceLifecycleEvents & {
  resolvedAddress: ResolvedAddressRecord
  resolvedName: ResolvedNameRecord
  resolvedAvatar: ResolvedAvatarRecord
}

const ipfsGateway = new URL("https://ipfs.io/ipfs/")
const arweaveGateway = new URL("https://arweave.net/")

/**
 * Given a url and a base URL, adjust the url to match the protocol and
 * hostname of the base URL, and append the hostname and remaining path of the
 * original url as path components in the base URL. Preserves querystrings and
 * hash data if present.
 *
 * @example
 * url: `ipfs://CID/path/to/resource`
 * baseURL: `https://ipfs.io/ipfs/`
 * result: `https://ipfs.io/ipfs/CID/path/to/resource`
 *
 * @example
 * url: `ipfs://CID/path/to/resource?parameters#hash`
 * baseURL: `https://ipfs.io/ipfs/`
 * result: `https://ipfs.io/ipfs/CID/path/to/resource?parameters#hash`
 */
function changeURLProtocolAndBase(url: URL, baseURL: URL) {
  const newURL = new URL(url)
  newURL.protocol = baseURL.protocol
  newURL.hostname = baseURL.hostname
  newURL.pathname = `${baseURL.pathname}/${url.hostname}/${url.pathname}`

  return newURL
}

// TODO eventually we want proper IPFS and Arweave support
function storageGatewayURL(url: URL): URL {
  switch (url.protocol) {
    case "ipfs":
      return changeURLProtocolAndBase(url, ipfsGateway)
    case "ar":
      return changeURLProtocolAndBase(url, arweaveGateway)
    default:
      return url
  }
}

/**
 * The NameService is responsible for resolving human-readable names into
 * addresses and other metadata across multiple networks, caching where
 * appropriate.
 *
 * Initially, the service supports ENS on mainnet Ethereum.
 */
export default class NameService extends BaseService<Events> {
  private cachedEIP155AvatarURLs: Record<string, URL> = {}

  private cachedResolvedNames: Record<string, ResolvedNameRecord> = {}

  private addressResolvers: NameResolverFunction[] = []

  /**
   * Create a new NameService. The service isn't initialized until
   * startService() is called and resolved.
   *
   * @param chainService - Required for chain interactions.
   * @returns A new, initializing ChainService
   */
  static create: ServiceCreatorFunction<
    Events,
    NameService,
    [Promise<ChainService>, Promise<PreferenceService>]
  > = async (chainService, preferenceService) => {
    return new this(await chainService, await preferenceService)
  }

  private constructor(
    private chainService: ChainService,
    private preferenceService: PreferenceService
  ) {
    super({})

    this.addressResolvers = [
      ...this.addressResolvers,
      ensAddressResolverFor(chainService),
      addressBookResolverFor(preferenceService),
      knownContractResolverFor(preferenceService),
    ]

    chainService.emitter.on(
      "newAccountToTrack",
      async ({ address, network }) => {
        try {
          await this.lookUpName(address, network)
        } catch (error) {
          logger.error("Error fetching ENS name for address", address, error)
        }
      }
    )
    this.emitter.on(
      "resolvedName",
      async ({
        from: {
          addressNetwork: { address, network },
        },
      }) => {
        try {
          const avatar = await this.lookUpAvatar(address, network)

          if (avatar) {
            this.emitter.emit("resolvedAvatar", {
              from: { addressNetwork: { address, network } },
              resolved: { avatar },
              system: "ENS",
            })
          }
        } catch (error) {
          logger.error("Error fetching avatar for address", address, error)
        }
      }
    )
  }

  async lookUpEthereumAddress(
    name: DomainName
  ): Promise<HexString | undefined> {
    // if doesn't end in .eth, throw. TODO turn on other domain endings soon +
    // include support for UNS
    if (!name.match(/.*\.eth$/)) {
      throw new Error("Only .eth names can be resolved today.")
    }
    // TODO ENS lookups should work on Ethereum mainnet and a few testnets as well.
    // This is going to be strange, though, as we'll be looking up ENS names for
    // non-Ethereum networks (eg eventually Bitcoin).
    const provider = this.chainService.providers.ethereum
    // TODO cache name resolution and TTL
    const address = await provider.resolveName(name)
    if (!address || !address.match(/^0x[a-zA-Z0-9]*$/)) {
      return undefined
    }
    const normalized = normalizeEVMAddress(address)
    this.emitter.emit("resolvedAddress", {
      from: { name },
      resolved: { addressNetwork: { address: normalized, network: ETHEREUM } },
      system: "ENS",
    })
    return normalized
  }

  async lookUpName(
    address: HexString,
    network: EVMNetwork,
    checkCache = true
  ): Promise<DomainName | undefined> {
    // TODO ENS lookups should work on a few testnets as well
    if (network.chainID !== "1") {
      throw new Error("Only Ethereum mainnet is supported.")
    }

    if (checkCache && address in this.cachedResolvedNames) {
      const {
        resolved: { name, expiresAt },
      } = this.cachedResolvedNames[address]

      if (expiresAt >= Date.now()) {
        return name
      }
    }

    const attemptedResolutions = await Promise.allSettled(
      this.addressResolvers.map((resolver) => resolver({ address, network }))
    )

    const resolvedNameRecord = attemptedResolutions
      .map((result) =>
        result.status === "fulfilled" ? result.value : undefined
      )
      .find((result) => result !== undefined)

    if (resolvedNameRecord === undefined) {
      return undefined
    }

    const existingName = this.cachedResolvedNames[address]?.resolved?.name
    this.cachedResolvedNames[address] = resolvedNameRecord

    // Only emit an event if the resolved name changed.
    if (existingName !== resolvedNameRecord.resolved.name) {
      this.emitter.emit("resolvedName", resolvedNameRecord)
    }

    return resolvedNameRecord.resolved.name
  }

  async lookUpAvatar(
    address: HexString,
    network: EVMNetwork
  ): Promise<URL | undefined> {
    // TODO ENS lookups should work on a few testnets as well
    if (network.chainID !== "1") {
      throw new Error("Only Ethereum mainnet is supported.")
    }
    const name = await this.lookUpName(address, network)
    if (!name) {
      return undefined
    }
    // TODO handle if it doesn't exist
    const provider = this.chainService.providers.ethereum
    const resolver = await provider.getResolver(name)
    if (!sameEVMAddress(await resolver?.getAddress(), address)) {
      return undefined
    }

    const avatar = await resolver?.getText("avatar")

    if (avatar) {
      if (avatar.match(/^eip155:1\/erc721:/)) {
        // check if we've cached the resolved URI, otherwise hit the chain
        if (avatar.toLowerCase() in this.cachedEIP155AvatarURLs) {
          // TODO properly cache this with any other non-ENS NFT stuff we do
          return this.cachedEIP155AvatarURLs[avatar.toLowerCase()]
        }
        // these URIs look like eip155:1/erc721:0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6/2430
        // check the spec for more details https://gist.github.com/Arachnid/9db60bd75277969ee1689c8742b75182
        const [, , , erc721Address, nftID] = avatar.split(/[:/]/)
        if (
          typeof erc721Address !== "undefined" &&
          typeof nftID !== "undefined"
        ) {
          const metadata = await getTokenMetadata(
            provider,
            erc721Address,
            BigInt(nftID)
          )

          if (metadata && metadata.image) {
            const { image } = metadata
            const resolvedGateway = storageGatewayURL(new URL(image))
            this.cachedEIP155AvatarURLs[avatar] = resolvedGateway
            return resolvedGateway
          }
        }
      }
      return storageGatewayURL(new URL(avatar))
    }

    return undefined
  }
}
// TODO resolve other network addresses (eg Bitcoin)
// TODO resolve content, eg IPFS hashes
