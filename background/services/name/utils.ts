import { AddressOnNetwork } from "../../accounts"
import { SECOND } from "../../constants"
import { normalizeEVMAddress } from "../../lib/utils"
import { DomainName, HexString, UNIXTime } from "../../types"
import ChainService from "../chain"
import PreferenceService from "../preferences"

export type NameResolverSystem =
  | "ENS"
  | "UNS"
  | "address-book"
  | "known-contracts"

export type ResolvedNameRecord = {
  from: {
    addressNetwork: AddressOnNetwork
  }
  resolved: {
    name: DomainName
    expiresAt: UNIXTime
  }
  system: NameResolverSystem
}

export type ResolvedAddressRecord = {
  from: {
    name: DomainName
  }
  resolved: {
    addressNetwork: AddressOnNetwork
  }
  system: NameResolverSystem
}

export type ResolvedAvatarRecord = {
  from: {
    addressNetwork: AddressOnNetwork
  }
  resolved: {
    avatar: URL
  }
  system: NameResolverSystem
}

export type NameResolverFunction = (
  addressOnNetwork: AddressOnNetwork
) => Promise<ResolvedNameRecord | undefined>

// A minimum record expiry that avoids infinite resolution loops.
const MINIMUM_RECORD_EXPIRY = 10 * SECOND

export function ensAddressResolverFor(
  chainService: ChainService
): NameResolverFunction {
  return async ({ address, network }: AddressOnNetwork) => {
    const name = await chainService
      .providerForNetwork(network)
      ?.lookupAddress(address)

    // TODO proper domain name validation ala RFC2181
    if (
      name === undefined ||
      name === null ||
      !(
        name.length <= 253 &&
        name.match(
          /^[a-zA-Z0-9][a-zA-Z0-9-]{1,62}\.([a-zA-Z0-9][a-zA-Z0-9-]{1,62}\.)*[a-zA-Z0-9][a-zA-Z0-9-]{1,62}/
        )
      )
    ) {
      return undefined
    }

    return {
      from: { addressNetwork: { address, network } },
      resolved: {
        name,
        // TODO Start reading this from ENS; for now, this avoids infinite
        // TODO resolution loops.
        expiresAt: Date.now() + MINIMUM_RECORD_EXPIRY,
      },
      system: "ENS",
    }
  }
}

export function addressBookResolverFor(
  preferenceService: PreferenceService
): NameResolverFunction {
  return async ({ address, network }: AddressOnNetwork) => {
    const name = (await preferenceService.getAddressBook()).evm[
      normalizeEVMAddress(address)
    ]

    if (name === undefined) {
      return undefined
    }

    return {
      from: { addressNetwork: { address, network } },
      resolved: {
        name,
        expiresAt: Date.now() + MINIMUM_RECORD_EXPIRY,
      },
      system: "address-book",
    }
  }
}

export function knownContractResolverFor(
  preferenceService: PreferenceService
): NameResolverFunction {
  return async ({ address, network }: AddressOnNetwork) => {
    const name = (await preferenceService.getKnownContractNames()).evm[
      normalizeEVMAddress(address)
    ]

    if (name === undefined) {
      return undefined
    }

    return {
      from: { addressNetwork: { address, network } },
      resolved: {
        name,
        expiresAt: Date.now() + MINIMUM_RECORD_EXPIRY,
      },
      system: "known-contracts",
    }
  }
}
