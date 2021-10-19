/* global location */
import { browser } from "webextension-polyfill-ts"

interface LedgerBridge {
  addAddressToTrack(address: string): void
}

declare global {
  interface Window {
    ledgerBridge?: LedgerBridge
  }
}

// if this is the Ledger bridge page, then open a port between this page and
// the extension
if (location.href.match(/^.*ledger-bridge.html$/)) {
  const port = browser.runtime.connect({ name: "ledger-bridge" })

  window.ledgerBridge = {
    addAddressToTrack: (address: string) => {
      port.postMessage({
        action: "addAddressToTrack",
        address,
      })
    },
  }
}
