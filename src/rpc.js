/**
 * RPC layer — thin wrapper over JSON-RPC via fetch.
 * Uses direct fetch() for reads (minimal deps), @solana/kit for tx construction only.
 */
import { deserializeMultisig, deserializeProposal, deserializeTransaction, deserializeVaultBatchTransaction, getProposalPda, getTransactionPda, getBatchTransactionPda, encodeBase58, resolveLookupKeys, PROGRAM_ID } from './squads.js';

const RPC_TIMEOUT = 10_000; // 10 seconds
const ADDRESS_LOOKUP_TABLE_PROGRAM_ID = 'AddressLookupTab1e1111111111111111111111111';

/**
 * Resolve Address Lookup Table accounts and append the looked-up keys
 * to message.accountKeys so instruction account indices work correctly.
 */
async function resolveAddressTableLookups(rpcUrl, message) {
  if (!message.addressTableLookups || message.addressTableLookups.length === 0) return;
  message.verificationErrors = [];

  const altAddresses = message.addressTableLookups.map(a => a.accountKey);
  const response = await rpcCall(rpcUrl, 'getMultipleAccounts', [
    altAddresses,
    { encoding: 'base64', commitment: 'confirmed' },
  ]);

  if (!Array.isArray(response?.value)) {
    message.verificationErrors.push('Address lookup tables could not be loaded');
    return;
  }

  // ALT layout: 56-byte header, then 32-byte pubkeys.
  const HEADER_SIZE = 56;
  const tableKeysPerLookup = message.addressTableLookups.map((_, i) => {
    const accountInfo = response.value[i];
    if (!accountInfo?.data || accountInfo.owner !== ADDRESS_LOOKUP_TABLE_PROGRAM_ID) return null;
    const encodedData = Array.isArray(accountInfo.data) ? accountInfo.data[0] : accountInfo.data;
    if (typeof encodedData !== 'string') return null;
    const altData = base64ToUint8Array(encodedData);
    const keys = [];
    for (let offset = HEADER_SIZE; offset + 32 <= altData.length; offset += 32) {
      keys.push(encodeBase58(altData.slice(offset, offset + 32)));
    }
    return keys;
  });

  const staticCount = message.accountKeys.length;
  const { writable, readonly, unresolved } = resolveLookupKeys(message.addressTableLookups, tableKeysPerLookup);
  message.accountKeys.push(...writable, ...readonly);
  message.numStaticKeys = staticCount;
  message.numLoadedWritable = writable.length;
  message.numLoadedReadonly = readonly.length;
  message.verificationErrors.push(...unresolved.map(({ table, addressIndex, access }) =>
    `ALT ${table || 'unknown'} ${access} index ${addressIndex} could not be resolved`
  ));
}

async function rpcCall(rpcUrl, method, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT);

  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`RPC HTTP error: ${response.status}`);
    }

    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`RPC returned invalid JSON (${text.slice(0, 100)})`);
    }
    if (json.error) {
      throw new Error(`RPC error: ${json.error.message || JSON.stringify(json.error)}`);
    }

    return json.result;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('RPC request timed out (10s)');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Check if an address is a Squads multisig account, a vault, or something else.
 * If it's a vault, attempt to find the parent multisig.
 * Returns { type: 'multisig'|'vault'|'unknown', multisigAddress, data }
 */
export async function resolveMultisigAddress(rpcUrl, inputAddress) {
  const result = await rpcCall(rpcUrl, 'getAccountInfo', [
    inputAddress,
    { encoding: 'base64', commitment: 'confirmed' },
  ]);

  if (!result?.value) {
    throw new Error('Account not found on-chain: ' + inputAddress);
  }

  const owner = result.value.owner;
  const accountData = result.value.data;
  const base64Str = Array.isArray(accountData) ? accountData[0] : accountData;
  const dataLen = base64Str ? base64ToUint8Array(base64Str).length : 0;

  // Case 1: Owned by Squads program with data — it's a multisig account
  if (owner === 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf' && dataLen > 0) {
    return { type: 'multisig', multisigAddress: inputAddress };
  }

  // Case 2: Owned by System Program (likely a vault or wallet)
  // Try the Squads API to resolve vault → multisig PDA
  if (owner === '11111111111111111111111111111111') {
    try {
      const apiResp = await fetch('https://v4-api.squads.so/multisig/' + inputAddress, {
        signal: AbortSignal.timeout(5000),
      });
      if (apiResp.ok) {
        const apiData = await apiResp.json();
        if (apiData?.address) {
          return {
            type: 'multisig',
            multisigAddress: apiData.address,
            resolvedFrom: inputAddress,
            message: 'Resolved vault → multisig PDA: ' + apiData.address,
          };
        }
      }
    } catch { /* API unavailable — fall through */ }

    return {
      type: 'wallet',
      owner,
      balance: result.value.lamports,
      message: 'This address is a wallet (owned by System Program). If this is a Squads vault, the multisig PDA could not be resolved. Try entering the multisig PDA directly.',
    };
  }

  // Case 3: Owned by smart-account-program
  if (owner === 'SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG' && dataLen > 0) {
    return {
      type: 'smart-account',
      multisigAddress: inputAddress,
      message: 'This is a Smart Account program multisig. This verifier currently only supports Squads v4 (SQDS4ep...). Smart Account support is planned.',
    };
  }

  return {
    type: 'unknown',
    owner,
    dataLen,
    message: `Account is owned by ${owner} with ${dataLen} bytes of data. Expected a Squads v4 multisig account (owned by SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf).`,
  };
}

/**
 * Fetch and deserialize a Multisig account.
 */
export async function fetchMultisig(rpcUrl, multisigAddress) {
  const result = await rpcCall(rpcUrl, 'getAccountInfo', [
    multisigAddress,
    { encoding: 'base64', commitment: 'confirmed' },
  ]);

  if (!result) {
    throw new Error('RPC returned null result for: ' + multisigAddress);
  }
  if (!result.value) {
    throw new Error('Account not found on-chain (result.value is null). Check the address and RPC URL.');
  }

  const accountData = result.value.data;
  if (!accountData) {
    throw new Error('Account exists but has no data field. Owner: ' + (result.value.owner || 'unknown'));
  }

  // getAccountInfo returns data as [base64String, encoding]
  const base64Str = Array.isArray(accountData) ? accountData[0] : accountData;
  if (!base64Str || base64Str.length === 0) {
    throw new Error('Account data is empty (0 bytes). This may not be a Squads multisig account.');
  }

  const data = base64ToUint8Array(base64Str);
  if (data.length < 8) {
    throw new Error('Account data too short (' + data.length + ' bytes). Expected a Squads multisig account (minimum ~120 bytes).');
  }

  return deserializeMultisig(data);
}

/**
 * Fetch proposals for a range of transaction indices.
 * Returns array of { index, proposal } objects (skips null/non-existent).
 */
export async function fetchProposalBatch(rpcUrl, multisigAddress, fromIndex, toIndex) {
  // Derive all proposal PDAs
  const pdaPromises = [];
  for (let i = toIndex; i >= fromIndex; i--) {
    pdaPromises.push(
      getProposalPda(multisigAddress, i).then(([pdaBytes]) => ({ index: i, pda: encodeBase58(pdaBytes) }))
    );
  }
  const pdas = await Promise.all(pdaPromises);

  // Batch fetch (max 100 per call) — addresses must be base58 strings
  const results = [];
  for (let i = 0; i < pdas.length; i += 100) {
    const batch = pdas.slice(i, i + 100);
    const addresses = batch.map(p => p.pda);

    const response = await rpcCall(rpcUrl, 'getMultipleAccounts', [
      addresses,
      { encoding: 'base64', commitment: 'confirmed' },
    ]);

    if (response?.value) {
      for (let j = 0; j < response.value.length; j++) {
        const accountInfo = response.value[j];
        if (accountInfo?.data) {
          try {
            const data = base64ToUint8Array(accountInfo.data[0]);
            const proposal = deserializeProposal(data);
            results.push({ index: batch[j].index, ...proposal });
          } catch {
            // Skip unparseable proposals
          }
        }
      }
    }
  }

  return results;
}

/**
 * Fetch and deserialize a transaction account (VaultTransaction, ConfigTransaction, or Batch).
 * For Batch accounts, also fetches all inner VaultBatchTransactions.
 */
export async function fetchTransaction(rpcUrl, multisigAddress, index) {
  const [pdaBytes] = await getTransactionPda(multisigAddress, index);
  const pda = encodeBase58(pdaBytes);

  const result = await rpcCall(rpcUrl, 'getAccountInfo', [
    pda,
    { encoding: 'base64', commitment: 'confirmed' },
  ]);

  if (!result?.value?.data) {
    throw new Error('Transaction account not found for index ' + index);
  }
  if (result.value.owner !== PROGRAM_ID) {
    throw new Error('Transaction account is not owned by the Squads v4 program');
  }

  const data = base64ToUint8Array(result.value.data[0]);
  const tx = deserializeTransaction(data);
  tx.verificationErrors = tx.verificationErrors || [];

  if (tx.multisig && tx.multisig !== multisigAddress) {
    tx.verificationErrors.push('Transaction multisig does not match the requested multisig');
  }
  if (tx.index !== undefined && tx.index !== BigInt(index)) {
    tx.verificationErrors.push('Transaction index does not match the requested proposal');
  }

  // Resolve Address Lookup Tables for vault transactions
  if (tx.type === 'vault' && tx.message?.addressTableLookups?.length > 0) {
    await resolveAddressTableLookups(rpcUrl, tx.message);
    tx.verificationErrors.push(...(tx.message.verificationErrors || []));
  }

  // For Batch accounts, fetch inner VaultBatchTransactions to get actual instructions
  if (tx.type === 'batch' && tx.size > 0) {
    const innerTxs = [];
    // Batch transactions are 1-indexed
    const pdaPromises = [];
    for (let i = 1; i <= tx.size; i++) {
      pdaPromises.push(
        getBatchTransactionPda(multisigAddress, index, i)
          .then(([bytes]) => ({ innerIndex: i, pda: encodeBase58(bytes) }))
      );
    }
    const innerPdas = await Promise.all(pdaPromises);
    const addresses = innerPdas.map(p => p.pda);

    const innerResult = await rpcCall(rpcUrl, 'getMultipleAccounts', [
      addresses,
      { encoding: 'base64', commitment: 'confirmed' },
    ]);

    if (Array.isArray(innerResult?.value)) {
      for (let i = 0; i < innerPdas.length; i++) {
        const info = innerResult.value[i];
        const innerIndex = innerPdas[i].innerIndex;
        if (!info?.data) {
          tx.verificationErrors.push(`Batch transaction ${innerIndex} is unavailable`);
          continue;
        }
        if (info.owner !== PROGRAM_ID) {
          tx.verificationErrors.push(`Batch transaction ${innerIndex} is not owned by the Squads v4 program`);
          continue;
        }
        try {
          const innerData = base64ToUint8Array(info.data[0]);
          const innerTx = deserializeVaultBatchTransaction(innerData);
          if (innerTx.message?.addressTableLookups?.length > 0) {
            await resolveAddressTableLookups(rpcUrl, innerTx.message);
            tx.verificationErrors.push(...(innerTx.message.verificationErrors || []).map(
              error => `Batch transaction ${innerIndex}: ${error}`
            ));
          }
          innerTxs.push({ innerIndex, ...innerTx });
        } catch (err) {
          tx.verificationErrors.push(`Batch transaction ${innerIndex} could not be decoded: ${err.message}`);
        }
      }
    } else {
      tx.verificationErrors.push('Batch transactions could not be loaded');
    }
    tx.innerTransactions = innerTxs;
  }

  return tx;
}

/**
 * Get SOL balance for an address.
 */
export async function fetchBalance(rpcUrl, address) {
  const result = await rpcCall(rpcUrl, 'getBalance', [
    address,
    { commitment: 'confirmed' },
  ]);
  return result?.value || 0;
}

/**
 * Get latest blockhash for transaction building.
 */
export async function fetchLatestBlockhash(rpcUrl) {
  const result = await rpcCall(rpcUrl, 'getLatestBlockhash', [
    { commitment: 'confirmed' },
  ]);
  return result.value;
}

/**
 * Simulate a transaction (base64 encoded).
 */
export async function simulateTransaction(rpcUrl, base64Tx) {
  const result = await rpcCall(rpcUrl, 'simulateTransaction', [
    base64Tx,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      replaceRecentBlockhash: true,
    },
  ]);
  return result.value;
}
