import '../style.css';
import { init, getState, setState } from './state.js';
import { createWalletManager } from './wallet.js';
import { fetchMultisig, fetchProposalBatch, fetchTransaction, resolveMultisigAddress } from './rpc.js';
import { deserializeMultisig, deserializeProposal, getProposalPda, getTransactionPda, PROPOSAL_DISCRIMINATOR, VAULT_TX_DISCRIMINATOR, CONFIG_TX_DISCRIMINATOR, getTransactionVerificationErrors } from './squads.js';
import { renderLayout, renderSetup, showToast } from './ui-layout.js';

// Generation guards for async race condition protection
function createGuard() {
  let current = 0;
  return {
    next() { return ++current; },
    isStale(captured) { return captured !== current; },
    get current() { return current; },
  };
}

const settingsGuard = createGuard();
const paginationGuard = createGuard();
const expandGuard = createGuard();

// Per-proposal action states: Map<string, 'idle'|'refetching'|'signing'|'confirming'>
const proposalActions = new Map();

let walletManager = null;

// MutationObserver: detect runtime script injection
new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.tagName === 'SCRIPT' && !node.hasAttribute('data-webpack')) {
        document.body.textContent = 'Security violation: unexpected script detected. Reload from a trusted source.';
        throw new Error('Script injection detected');
      }
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

// Tab visibility: refresh on return after 30s
let lastVisibleTimestamp = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const elapsed = Date.now() - lastVisibleTimestamp;
    if (elapsed > 30_000) {
      const anyActionInProgress = [...proposalActions.values()].some(s => s !== 'idle');
      if (!anyActionInProgress) {
        settingsGuard.next();
        loadProposals();
      }
    }
  } else {
    lastVisibleTimestamp = Date.now();
  }
});

// Cross-tab localStorage detection
window.addEventListener('storage', (e) => {
  if (['rpcUrl', 'multisigAddress', 'explorerUrl'].includes(e.key)) {
    showToast('Settings changed in another tab. Reloading...', 'info');
    setTimeout(() => location.reload(), 1500);
  }
});

// Main render
function render() {
  const state = getState();
  const root = document.getElementById('app');
  if (!root) return;

  root.textContent = '';
  root.className = '';

  if (!state.multisigAddress || !state.rpcUrl) {
    root.appendChild(renderSetup(onSetupComplete));
    return;
  }

  root.className = 'app';
  root.appendChild(renderLayout({
    state,
    walletManager,
    proposalActions,
    onConnect,
    onDisconnect,
    onSettings,
    onRefresh,
    onLoadMore,
    onExpandProposal,
    onApprove,
    onReject,
  }));
}

async function onSetupComplete(address, rpcUrl, explorerUrl) {
  // First, resolve what kind of account this is
  try {
    const resolved = await resolveMultisigAddress(rpcUrl, address);

    if (resolved.type === 'multisig') {
      if (resolved.resolvedFrom) {
        showToast('Resolved vault to multisig: ' + resolved.multisigAddress.slice(0, 8) + '...', 'info');
      }
      setState({ multisigAddress: resolved.multisigAddress, rpcUrl, explorerUrl });
      await loadMultisig();
      await loadProposals();
    } else {
      showToast(resolved.message, 'error');
    }
  } catch (err) {
    showToast('Failed to resolve address: ' + err.message, 'error');
  }
}

async function onConnect(wallet) {
  try {
    const account = await walletManager.connect(wallet);
    setState({ walletAccount: account, connectedWallet: wallet });
  } catch (err) {
    if (err?.code !== 4001) {
      showToast('Connection failed: ' + (err.message || 'Unknown error'), 'error');
    }
  }
}

async function onDisconnect() {
  await walletManager.disconnect();
  setState({ walletAccount: null, connectedWallet: null });
}

function onSettings() {
  // Settings modal is handled by ui-layout
  setState({ showSettings: true });
}

async function onRefresh() {
  settingsGuard.next();
  setState({ lastUpdated: null });
  await loadMultisig();
  await loadProposals();
}

async function onLoadMore() {
  const state = getState();
  if (state.loadingMore) return;

  const nextEnd = state.proposalCursor - 1;
  const nextStart = Math.max(1, nextEnd - 19);
  if (nextEnd < 1) return;

  setState({ loadingMore: true });
  const gen = paginationGuard.next();

  try {
    const batch = await fetchProposalBatch(state.rpcUrl, state.multisigAddress, nextStart, nextEnd);
    if (paginationGuard.isStale(gen)) return;

    setState({
      proposals: [...state.proposals, ...batch],
      proposalCursor: nextStart,
      loadingMore: false,
    });
  } catch (err) {
    if (paginationGuard.isStale(gen)) return;
    showToast('Failed to load more: ' + err.message, 'error');
  } finally {
    setState({ loadingMore: false });
  }
}

async function onExpandProposal(index) {
  const state = getState();
  if (state.expandedProposal === index) {
    setState({ expandedProposal: null, expandedTransaction: null });
    return;
  }

  setState({ expandedProposal: index, expandedTransaction: null, loadingDetail: true });
  const gen = expandGuard.next();

  try {
    const tx = await fetchTransaction(state.rpcUrl, state.multisigAddress, index);
    if (expandGuard.isStale(gen)) return;
    setState({ expandedTransaction: tx, loadingDetail: false });
  } catch (err) {
    if (expandGuard.isStale(gen)) return;
    showToast('Failed to load transaction: ' + err.message, 'error');
    setState({ loadingDetail: false });
  }
}

async function onApprove(index) {
  await executeVote(index, true);
}

async function onReject(index) {
  await executeVote(index, false);
}

async function executeVote(index, approve) {
  const key = String(index);
  if (proposalActions.get(key) && proposalActions.get(key) !== 'idle') {
    showToast('An action is already in progress for this proposal.', 'info');
    return;
  }

  const state = getState();
  if (!walletManager || !walletManager.isConnected()) {
    showToast('Please connect your wallet first.', 'error');
    return;
  }

  proposalActions.set(key, 'refetching');
  render();

  const gen = settingsGuard.next();

  try {
    // Dynamic import to keep initial load light
    const { buildVoteTransaction } = await import('./actions.js');
    if (settingsGuard.isStale(gen)) return;

    // Re-fetch proposal to check for stale state
    const freshProposals = await fetchProposalBatch(state.rpcUrl, state.multisigAddress, index, index);
    if (settingsGuard.isStale(gen)) return;

    const proposal = freshProposals[0];
    if (!proposal || proposal.status.tag !== 1) {
      showToast('Proposal is no longer active (status: ' + (proposal?.status.name || 'unknown') + ')', 'error');
      return;
    }

    // Rejecting an unverified proposal is always allowed. Approving requires a
    // fresh, complete decode so stale UI state cannot bypass verification.
    if (approve) {
      const freshTransaction = await fetchTransaction(state.rpcUrl, state.multisigAddress, index);
      if (settingsGuard.isStale(gen)) return;
      const verificationErrors = getTransactionVerificationErrors(freshTransaction);
      if (verificationErrors.length > 0) {
        showToast('Approval blocked: ' + verificationErrors.join('; '), 'error');
        return;
      }
    }

    proposalActions.set(key, 'signing');
    render();

    const account = walletManager.getAccount();
    const txBytes = await buildVoteTransaction(
      state.multisigAddress,
      account.address,
      index,
      approve,
      state.rpcUrl
    );

    const signature = await walletManager.signAndSendTransaction(txBytes);
    if (settingsGuard.isStale(gen)) return;

    proposalActions.set(key, 'confirming');
    render();
    showToast('Transaction sent! Confirming...', 'info');

    // Refresh the proposal after a short delay
    await new Promise(r => setTimeout(r, 2000));
    if (settingsGuard.isStale(gen)) return;

    await loadProposals();
    showToast(
      (approve ? 'Approved' : 'Rejected') + ' proposal #' + index,
      'success'
    );
  } catch (err) {
    if (err?.code === 4001 || (err?.message || '').toLowerCase().includes('user rejected')) {
      // User cancelled — silently reset
    } else {
      showToast('Vote failed: ' + (err.message || 'Unknown error'), 'error');
    }
  } finally {
    proposalActions.set(key, 'idle');
    render();
  }
}

async function loadMultisig() {
  const state = getState();
  if (!state.multisigAddress) return;

  setState({ loading: true, error: null });
  const gen = settingsGuard.current;

  try {
    const multisig = await fetchMultisig(state.rpcUrl, state.multisigAddress);
    if (settingsGuard.isStale(gen)) return;
    setState({ multisig, loading: false });
  } catch (err) {
    if (settingsGuard.isStale(gen)) return;
    setState({ loading: false, error: 'Failed to load multisig: ' + err.message, multisig: null, proposals: [] });
    showToast('Failed to load multisig: ' + err.message, 'error');
  }
}

async function loadProposals() {
  const state = getState();
  if (!state.multisig) return;

  setState({ loadingProposals: true });
  const gen = paginationGuard.next();

  try {
    const txIndex = Number(state.multisig.transactionIndex);
    const start = Math.max(1, txIndex - 19);

    const proposals = await fetchProposalBatch(state.rpcUrl, state.multisigAddress, start, txIndex);
    if (paginationGuard.isStale(gen)) return;

    // Initialize action states for each proposal
    for (const p of proposals) {
      if (!proposalActions.has(String(p.index))) {
        proposalActions.set(String(p.index), 'idle');
      }
    }

    setState({
      proposals,
      proposalCursor: start,
      loadingProposals: false,
      lastUpdated: new Date(),
    });
  } catch (err) {
    if (paginationGuard.isStale(gen)) return;
    showToast('Failed to load proposals: ' + err.message, 'error');
    setState({ loadingProposals: false });
  }
}

// Boot
async function boot() {
  walletManager = createWalletManager({ chain: 'solana:mainnet' });

  walletManager.addEventListener('connectionChanged', (info) => {
    if (info) {
      setState({ walletAccount: info.account, connectedWallet: info.wallet });
    } else {
      // Wallet disconnected — cancel in-flight actions
      for (const [key] of proposalActions) {
        proposalActions.set(key, 'idle');
      }
      settingsGuard.next();
      setState({ walletAccount: null, connectedWallet: null });
    }
  });

  walletManager.addEventListener('accountChanged', (account) => {
    setState({ walletAccount: account });
  });

  init(render);

  const state = getState();
  if (state.multisigAddress) {
    await loadMultisig();
    await loadProposals();
  }
}

boot().catch((err) => {
  console.error('Boot failed:', err);
  showToast('Failed to initialize: ' + err.message, 'error');
});

export { settingsGuard, paginationGuard, proposalActions };
