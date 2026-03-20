import { createAppKit, type ChainAdapter } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { mainnet } from '@reown/appkit/networks';
import { injected } from 'wagmi/connectors';
import {
  getAccount,
  getChainId,
  watchAccount,
  signMessage as wagmiSignMessage,
  type Config,
} from '@wagmi/core';

let _modal: ReturnType<typeof createAppKit> | null = null;
let _config: Config | null = null;
let _pendingAccountCbs: ((addr: string | undefined) => void)[] = [];

function init(projectId: string): void {
  if (_modal) return;
  const adapter = new WagmiAdapter({
    networks: [mainnet],
    projectId,
    connectors: [injected()],
  });
  _config = adapter.wagmiConfig as Config;
  _modal = createAppKit({
    adapters: [adapter as unknown as ChainAdapter],
    networks: [mainnet],
    projectId,
    enableCoinbase: false,
    themeMode: 'dark',
    themeVariables: {
      '--w3m-accent': '#c4f84a',
      '--w3m-border-radius-master': '0px',
      '--w3m-font-family': "'DM Mono', monospace",
    },
  });

  // Flush any callbacks registered before init
  for (const cb of _pendingAccountCbs) {
    registerAccountWatcher(cb);
  }
  _pendingAccountCbs = [];
}

function registerAccountWatcher(cb: (addr: string | undefined) => void): () => void {
  const cfg = _config!;
  let prev = getAccount(cfg).address?.toLowerCase();
  return watchAccount(cfg, {
    onChange(account) {
      const addr = account.address?.toLowerCase();
      if (addr !== prev) {
        prev = addr;
        cb(addr);
      }
    },
  });
}

export async function connectWallet(projectId: string, _siteUrl: string): Promise<string> {
  init(projectId);
  const cfg = _config!;

  // Already connected from a prior session — return immediately
  const existing = getAccount(cfg).address;
  if (existing) {
    const chainId = getChainId(cfg);
    if (chainId !== 1) console.warn(`Connected to chain ${chainId}, expected mainnet (1)`);
    return existing.toLowerCase();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let wasOpen = false;
    let unwatch: (() => void) | undefined;
    let unsub: (() => void) | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      unwatch?.();
      unsub?.();
      fn();
    };

    // Set up watchers BEFORE calling modal.open() so no events are missed
    unwatch = watchAccount(cfg, {
      onChange(account) {
        if (account.address) {
          const chainId = getChainId(cfg);
          if (chainId !== 1) console.warn(`Connected to chain ${chainId}, expected mainnet (1)`);
          settle(() => resolve(account.address!.toLowerCase()));
        }
      },
    });

    unsub = _modal!.subscribeState((state: { open: boolean }) => {
      if (state.open) {
        wasOpen = true;
      } else if (wasOpen && !getAccount(cfg).address) {
        // Don't reject if wagmi is still in the process of reconnecting — the
        // modal may close before wagmi finishes restoring an existing session.
        // watchAccount will resolve the promise once reconnection completes.
        const { status } = getAccount(cfg);
        if (status === 'reconnecting' || status === 'connecting') return;
        settle(() => reject(new Error('Connection cancelled')));
      }
    });

    // Re-check after watcher setup: wagmi's async reconnection (e.g. Rabby already
    // connected) may have completed between init() and here, before watchAccount fired.
    const reconnected = getAccount(cfg).address;
    if (reconnected) {
      settle(() => resolve(reconnected.toLowerCase()));
      return;
    }

    _modal!.open();
  });
}

export async function signMessage(message: string, expectedAddress: string): Promise<string> {
  if (!_config) throw new Error('Wallet not initialized — call connectWallet first');

  const connected = getAccount(_config).address?.toLowerCase();
  if (connected !== expectedAddress.toLowerCase()) {
    throw new Error(
      `Connected account (${connected ?? 'none'}) does not match expected signer (${expectedAddress}). Please switch back or reload.`,
    );
  }

  try {
    return await wagmiSignMessage(_config, { message });
  } catch (e) {
    // Check if wallet disconnected during signing
    if (!getAccount(_config).address) {
      throw new Error('Wallet disconnected — please reconnect');
    }
    throw e;
  }
}

export function getConnectedAddress(): string | undefined {
  if (!_config) return undefined;
  return getAccount(_config).address?.toLowerCase();
}

/**
 * Returns the connected address if wagmi already has a session (including
 * async reconnect). Returns null if not connected after waiting.
 * Never opens the modal — safe to call on page load without user interaction.
 */
export async function reconnectIfAvailable(projectId: string): Promise<string | null> {
  init(projectId);
  const cfg = _config!;

  const acct = getAccount(cfg);
  if (acct.address) return acct.address.toLowerCase();
  if (acct.status !== 'reconnecting' && acct.status !== 'connecting') return null;

  return new Promise((resolve) => {
    let unwatch: (() => void) | undefined;
    const timer = setTimeout(() => {
      unwatch?.();
      resolve(null);
    }, 3000);

    unwatch = watchAccount(cfg, {
      onChange(account) {
        if (account.status === 'connected' || account.status === 'disconnected') {
          clearTimeout(timer);
          unwatch?.();
          resolve(account.address?.toLowerCase() ?? null);
        }
      },
    });
  });
}

export function onAccountChange(cb: (addr: string | undefined) => void): () => void {
  if (!_config) {
    _pendingAccountCbs.push(cb);
    return () => {
      _pendingAccountCbs = _pendingAccountCbs.filter(c => c !== cb);
    };
  }
  return registerAccountWatcher(cb);
}
