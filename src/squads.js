/**
 * Squads Protocol v4 — Borsh deserialization, PDA derivation, account parsing.
 * Hand-written from the IDL and Rust source. ZERO external dependencies.
 */
import { findProgramAddress } from './crypto.js';

// Program ID — hardcoded to canonical Squads v4 deployment
export const PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

// ─── Discriminators (sha256("account:<Name>")[0..8]) ───

// All account discriminators from @sqds/multisig v2.1.4
export const MULTISIG_DISCRIMINATOR      = new Uint8Array([0xe0, 0x74, 0x79, 0xba, 0x44, 0xa1, 0x4f, 0xec]);
export const PROPOSAL_DISCRIMINATOR      = new Uint8Array([0x1a, 0x5e, 0xbd, 0xbb, 0x74, 0x88, 0x35, 0x21]);
export const VAULT_TX_DISCRIMINATOR      = new Uint8Array([0xa8, 0xfa, 0xa2, 0x64, 0x51, 0x0e, 0xa2, 0xcf]);
export const CONFIG_TX_DISCRIMINATOR     = new Uint8Array([0x5e, 0x08, 0x04, 0x23, 0x71, 0x8b, 0x8b, 0x70]);
export const BATCH_DISCRIMINATOR         = new Uint8Array([0x9c, 0xc2, 0x46, 0x2c, 0x16, 0x58, 0x89, 0x2c]);
export const VAULT_BATCH_TX_DISC         = new Uint8Array([0xc4, 0x79, 0x2e, 0x24, 0x0c, 0x13, 0xfc, 0x07]);
export const SPENDING_LIMIT_DISCRIMINATOR = new Uint8Array([0x0a, 0xc9, 0x1b, 0xa0, 0xda, 0xc3, 0xde, 0x98]);
export const PROGRAM_CONFIG_DISCRIMINATOR = new Uint8Array([0xc4, 0xd2, 0x5a, 0xe7, 0x90, 0x95, 0x8c, 0x3f]);
export const TX_BUFFER_DISCRIMINATOR     = new Uint8Array([0x5a, 0x24, 0x23, 0xdb, 0x5d, 0xe1, 0x6e, 0x60]);

// Instruction discriminators (sha256("global:<name>")[0..8])
export const APPROVE_DISC  = new Uint8Array([0x90, 0x25, 0xa4, 0x88, 0xbc, 0xd8, 0x2a, 0xf8]);
export const REJECT_DISC   = new Uint8Array([0xf3, 0x3e, 0x86, 0x9c, 0xe6, 0x6a, 0xf6, 0x87]);
export const CREATE_DISC   = new Uint8Array([0xdc, 0x3c, 0x49, 0xe0, 0x1e, 0x6c, 0x4f, 0x9f]);
export const ACTIVATE_DISC = new Uint8Array([0x0b, 0x22, 0x5c, 0xf8, 0x9a, 0x1b, 0x33, 0x6a]);

// ─── BorshReader ───

export class BorshReader {
  constructor(buffer) {
    this.buf = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    this.offset = 0;
  }

  _check(n) {
    if (this.offset + n > this.buf.length) {
      throw new Error(`Borsh: attempted to read ${n} bytes at offset ${this.offset}, buffer length ${this.buf.length}`);
    }
  }

  readU8() {
    this._check(1);
    return this.buf[this.offset++];
  }

  readU16() {
    this._check(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  readU32() {
    this._check(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  readU64() {
    this._check(8);
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readI64() {
    this._check(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  readPubkey() {
    this._check(32);
    const bytes = this.buf.slice(this.offset, this.offset + 32);
    this.offset += 32;
    return bytes;
  }

  readPubkeyBase58() {
    const bytes = this.readPubkey();
    return encodeBase58(bytes);
  }

  readBytes(n) {
    this._check(n);
    const bytes = this.buf.slice(this.offset, this.offset + n);
    this.offset += n;
    return bytes;
  }

  readVec(readFn, maxLen = 65535) {
    const len = this.readU32();
    if (len > maxLen) throw new Error(`Borsh: vec length ${len} exceeds max ${maxLen}`);
    this._check(0); // ensure we haven't already overrun
    const result = [];
    for (let i = 0; i < len; i++) {
      result.push(readFn(this));
    }
    return result;
  }

  readVecU8(maxLen = 65535) {
    const len = this.readU32();
    if (len > maxLen) throw new Error(`Borsh: byte vec length ${len} exceeds max ${maxLen}`);
    return this.readBytes(len);
  }

  readOption(readFn) {
    const tag = this.readU8();
    if (tag === 0) return null;
    if (tag === 1) return readFn(this);
    throw new Error(`Borsh: invalid Option tag ${tag}`);
  }

  readString(maxLen = 1024) {
    const len = this.readU32();
    if (len > maxLen) throw new Error(`Borsh: string length ${len} exceeds max ${maxLen}`);
    this._check(len);
    const s = new TextDecoder().decode(this.buf.slice(this.offset, this.offset + len));
    this.offset += len;
    return s;
  }

  readDiscriminator() {
    return this.readBytes(8);
  }

  matchDiscriminator(expected) {
    const disc = this.readDiscriminator();
    for (let i = 0; i < 8; i++) {
      if (disc[i] !== expected[i]) return false;
    }
    return true;
  }
}

// ─── Base58 encoding ───

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(bytes) {
  if (bytes.length === 0) return '';
  // Count leading zeros
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert to base58
  const b58 = new Uint8Array(bytes.length * 2);
  let length = 0;

  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    let j = 0;
    for (let k = b58.length - 1; k >= 0; k--, j++) {
      if (carry === 0 && j >= length) break;
      carry += 256 * b58[k];
      b58[k] = carry % 58;
      carry = (carry / 58) | 0;
    }
    length = j;
  }

  let result = '1'.repeat(zeros);
  let started = false;
  for (let i = 0; i < b58.length; i++) {
    if (!started && b58[i] === 0) continue;
    started = true;
    result += BASE58_ALPHABET[b58[i]];
  }
  return result || '1';
}

export function decodeBase58(str) {
  if (str.length === 0) return new Uint8Array(0);

  // Count leading '1's (they map to leading zero bytes)
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;

  // Allocate enough space (base58 ≈ 0.73 * base256)
  const size = Math.ceil(str.length * 733 / 1000) + 1;
  const b256 = new Uint8Array(size);

  for (let i = zeros; i < str.length; i++) {
    const c = BASE58_ALPHABET.indexOf(str[i]);
    if (c < 0) throw new Error(`Invalid base58 character: ${str[i]}`);
    let carry = c;
    for (let j = size - 1; j >= 0; j--) {
      carry += 58 * b256[j];
      b256[j] = carry & 0xff;
      carry >>= 8;
    }
  }

  // Skip leading zeros in the converted result (not the '1' prefix zeros)
  let start = 0;
  while (start < size && b256[start] === 0) start++;

  // Combine: leading zero bytes + converted bytes
  const result = new Uint8Array(zeros + (size - start));
  for (let i = start; i < size; i++) {
    result[zeros + (i - start)] = b256[i];
  }
  return result;
}

export function isValidBase58(str) {
  if (!str || str.length < 32 || str.length > 44) return false;
  try {
    const bytes = decodeBase58(str);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

export function shortenAddress(addr, chars = 4) {
  if (!addr) return '';
  return addr.slice(0, chars) + '...' + addr.slice(-chars);
}

// ─── PDA Derivation (zero-dependency, uses WebCrypto SHA-256 + BigInt curve math) ───

function u64ToLeBytes(n) {
  const buf = new Uint8Array(8);
  const view = new DataView(buf.buffer);
  view.setBigUint64(0, BigInt(n), true);
  return buf;
}

function textToBytes(str) {
  return new TextEncoder().encode(str);
}

const PROGRAM_ID_BYTES = decodeBase58(PROGRAM_ID);

export async function getMultisigVaultPda(multisigAddress, vaultIndex = 0) {
  return findProgramAddress(
    [textToBytes('multisig'), decodeBase58(multisigAddress), textToBytes('vault'), new Uint8Array([vaultIndex])],
    PROGRAM_ID_BYTES,
  );
}

export async function getTransactionPda(multisigAddress, index) {
  return findProgramAddress(
    [textToBytes('multisig'), decodeBase58(multisigAddress), textToBytes('transaction'), u64ToLeBytes(index)],
    PROGRAM_ID_BYTES,
  );
}

export async function getProposalPda(multisigAddress, index) {
  return findProgramAddress(
    [textToBytes('multisig'), decodeBase58(multisigAddress), textToBytes('transaction'), u64ToLeBytes(index), textToBytes('proposal')],
    PROGRAM_ID_BYTES,
  );
}

export async function getBatchTransactionPda(multisigAddress, batchIndex, txIndex) {
  const txIndexBytes = new Uint8Array(4);
  new DataView(txIndexBytes.buffer).setUint32(0, txIndex, true);
  return findProgramAddress(
    [textToBytes('multisig'), decodeBase58(multisigAddress), textToBytes('transaction'), u64ToLeBytes(batchIndex), textToBytes('batch_transaction'), txIndexBytes],
    PROGRAM_ID_BYTES,
  );
}

// ─── Account Deserializers ───

const PROPOSAL_STATUS_NAMES = ['Draft', 'Active', 'Rejected', 'Approved', 'Executing', 'Executed', 'Cancelled'];
const PERMISSION_NAMES = { 1: 'Initiate', 2: 'Vote', 4: 'Execute' };

function readPermissions(mask) {
  const perms = [];
  for (const [bit, name] of Object.entries(PERMISSION_NAMES)) {
    if (mask & Number(bit)) perms.push(name);
  }
  return perms;
}

export function deserializeMultisig(data) {
  const reader = new BorshReader(data);

  if (!reader.matchDiscriminator(MULTISIG_DISCRIMINATOR)) {
    throw new Error('Invalid Multisig account discriminator');
  }

  const createKey = reader.readPubkeyBase58();
  const configAuthority = reader.readPubkeyBase58();
  const threshold = reader.readU16();
  const timeLock = reader.readU32();
  const transactionIndex = reader.readU64();
  const staleTransactionIndex = reader.readU64();
  const rentCollector = reader.readOption((r) => r.readPubkeyBase58());
  const bump = reader.readU8();

  const members = reader.readVec((r) => {
    const key = r.readPubkeyBase58();
    const permissionsMask = r.readU8();
    return { key, permissionsMask, permissions: readPermissions(permissionsMask) };
  }, 256);

  return {
    createKey,
    configAuthority,
    threshold,
    timeLock,
    transactionIndex,
    staleTransactionIndex,
    rentCollector,
    bump,
    members,
  };
}

function readProposalStatus(reader) {
  const tag = reader.readU8();
  const name = PROPOSAL_STATUS_NAMES[tag] || 'Unknown';

  // Executing (tag 4) has NO timestamp payload
  if (tag === 4) {
    return { tag, name, timestamp: null };
  }

  // All other variants have an i64 timestamp
  if (tag >= 0 && tag <= 6) {
    const timestamp = reader.readI64();
    return { tag, name, timestamp };
  }

  throw new Error(`Unknown ProposalStatus tag: ${tag}`);
}

export function deserializeProposal(data) {
  const reader = new BorshReader(data);

  if (!reader.matchDiscriminator(PROPOSAL_DISCRIMINATOR)) {
    throw new Error('Invalid Proposal account discriminator');
  }

  const multisig = reader.readPubkeyBase58();
  const transactionIndex = reader.readU64();
  const status = readProposalStatus(reader);
  const bump = reader.readU8();

  const approved = reader.readVec((r) => r.readPubkeyBase58(), 256);
  const rejected = reader.readVec((r) => r.readPubkeyBase58(), 256);
  const cancelled = reader.readVec((r) => r.readPubkeyBase58(), 256);

  return {
    multisig,
    transactionIndex,
    status,
    bump,
    approved,
    rejected,
    cancelled,
  };
}

function readCompiledInstruction(reader) {
  const programIdIndex = reader.readU8();
  const accountIndexes = reader.readVecU8(256);
  const data = reader.readVecU8(65535);
  return { programIdIndex, accountIndexes: Array.from(accountIndexes), data };
}

function readAddressTableLookup(reader) {
  const accountKey = reader.readPubkeyBase58();
  const writableIndexes = reader.readVecU8(256);
  const readonlyIndexes = reader.readVecU8(256);
  return { accountKey, writableIndexes: Array.from(writableIndexes), readonlyIndexes: Array.from(readonlyIndexes) };
}

/**
 * Order ALT keys as Solana MessageV0 does: all writable across every table, then
 * all readonly. Missing/out-of-range entries become '?' to keep indices aligned.
 */
export function resolveLookupKeys(addressTableLookups, tableKeysPerLookup) {
  const writable = [];
  const readonly = [];
  const unresolved = [];
  addressTableLookups.forEach((lookup, i) => {
    const keys = tableKeysPerLookup[i];
    const pick = (idx, access) => {
      if (keys && idx < keys.length) return keys[idx];
      unresolved.push({
        table: lookup.accountKey,
        tableIndex: i,
        addressIndex: idx,
        access,
      });
      return '?';
    };
    lookup.writableIndexes.forEach((idx) => writable.push(pick(idx, 'writable')));
    lookup.readonlyIndexes.forEach((idx) => readonly.push(pick(idx, 'readonly')));
  });
  return { writable, readonly, unresolved };
}

function readTransactionMessage(reader) {
  const numSigners = reader.readU8();
  const numWritableSigners = reader.readU8();
  const numWritableNonSigners = reader.readU8();
  const accountKeys = reader.readVec((r) => r.readPubkeyBase58(), 256);
  const instructions = reader.readVec(readCompiledInstruction, 256);
  const addressTableLookups = reader.readVec(readAddressTableLookup, 64);

  return {
    numSigners,
    numWritableSigners,
    numWritableNonSigners,
    accountKeys,
    instructions,
    addressTableLookups,
  };
}

export function deserializeVaultTransaction(data) {
  const reader = new BorshReader(data);

  if (!reader.matchDiscriminator(VAULT_TX_DISCRIMINATOR)) {
    throw new Error('Invalid VaultTransaction account discriminator');
  }

  const multisig = reader.readPubkeyBase58();
  const creator = reader.readPubkeyBase58();
  const index = reader.readU64();
  const bump = reader.readU8();
  const vaultIndex = reader.readU8();
  const vaultBump = reader.readU8();
  const ephemeralSignerBumps = reader.readVecU8(256);
  const message = readTransactionMessage(reader);

  return {
    type: 'vault',
    multisig,
    creator,
    index,
    bump,
    vaultIndex,
    vaultBump,
    ephemeralSignerBumps: Array.from(ephemeralSignerBumps),
    message,
  };
}

const CONFIG_ACTION_NAMES = [
  'AddMember', 'RemoveMember', 'ChangeThreshold', 'SetTimeLock',
  'AddSpendingLimit', 'RemoveSpendingLimit', 'SetRentCollector',
];

// Every branch must consume its variant's full Borsh payload: under-reading leaves
// the cursor mid-action, letting the next vec entry parse as a spoofed fake action.
function readConfigAction(reader) {
  const tag = reader.readU8();
  const name = CONFIG_ACTION_NAMES[tag] || `Unknown(${tag})`;

  switch (tag) {
    case 0: { // AddMember
      const key = reader.readPubkeyBase58();
      const permissionsMask = reader.readU8();
      return { name, member: { key, permissions: readPermissions(permissionsMask) } };
    }
    case 1: { // RemoveMember
      const key = reader.readPubkeyBase58();
      return { name, key };
    }
    case 2: { // ChangeThreshold
      const threshold = reader.readU16();
      return { name, threshold };
    }
    case 3: { // SetTimeLock
      const timeLock = reader.readU32();
      return { name, timeLock };
    }
    case 4: { // AddSpendingLimit
      const createKey = reader.readPubkeyBase58();
      const vaultIndex = reader.readU8();
      const mint = reader.readPubkeyBase58();
      const amount = reader.readU64().toString();
      const period = reader.readU8();
      if (period > 3) throw new Error(`Unknown spending-limit period ${period}`);
      const members = reader.readVec((r) => r.readPubkeyBase58());
      const destinations = reader.readVec((r) => r.readPubkeyBase58());
      return { name, raw: true, createKey, vaultIndex, mint, amount, period, members, destinations };
    }
    case 5: { // RemoveSpendingLimit
      const spendingLimit = reader.readPubkeyBase58();
      return { name, raw: true, spendingLimit };
    }
    case 6: { // SetRentCollector
      const rentCollector = reader.readOption((r) => r.readPubkeyBase58());
      return { name, raw: true, rentCollector };
    }
    default:
      // Unknown tag: payload length is unknowable, so fail closed rather than
      // continue parsing desynced, spoofable bytes.
      throw new Error(`Unknown ConfigAction tag ${tag}`);
  }
}

export function deserializeConfigTransaction(data) {
  const reader = new BorshReader(data);

  if (!reader.matchDiscriminator(CONFIG_TX_DISCRIMINATOR)) {
    throw new Error('Invalid ConfigTransaction account discriminator');
  }

  const multisig = reader.readPubkeyBase58();
  const creator = reader.readPubkeyBase58();
  const index = reader.readU64();
  const bump = reader.readU8();

  let actions;
  const verificationErrors = [];
  try {
    actions = reader.readVec(readConfigAction, 32);
  } catch (err) {
    actions = [{ name: 'UnparseableActions', raw: true }];
    verificationErrors.push('Configuration actions could not be decoded: ' + err.message);
  }

  return {
    type: 'config',
    multisig,
    creator,
    index,
    bump,
    actions,
    verificationErrors,
  };
}

// VaultBatchTransaction: discriminator(8) → bump(1) → ephemeralSignerBumps(vec) → message
export function deserializeVaultBatchTransaction(data) {
  const reader = new BorshReader(data);

  if (!reader.matchDiscriminator(VAULT_BATCH_TX_DISC)) {
    throw new Error('Invalid VaultBatchTransaction account discriminator');
  }

  const bump = reader.readU8();
  const ephemeralSignerBumps = reader.readVecU8(256);
  const message = readTransactionMessage(reader);

  return {
    type: 'vault',
    subtype: 'batch',
    bump,
    ephemeralSignerBumps: Array.from(ephemeralSignerBumps),
    message,
  };
}

// Batch: discriminator(8) → multisig(32) → creator(32) → index(8) → bump(1) → vaultIndex(1) → vaultBump(1) → size(4) → executedTransactionIndex(4)
export function deserializeBatch(data) {
  const reader = new BorshReader(data);

  if (!reader.matchDiscriminator(BATCH_DISCRIMINATOR)) {
    throw new Error('Invalid Batch account discriminator');
  }

  const multisig = reader.readPubkeyBase58();
  const creator = reader.readPubkeyBase58();
  const index = reader.readU64();
  const bump = reader.readU8();
  const vaultIndex = reader.readU8();
  const vaultBump = reader.readU8();
  const size = reader.readU32();
  const executedTransactionIndex = reader.readU32();

  return {
    type: 'batch',
    multisig,
    creator,
    index,
    bump,
    vaultIndex,
    vaultBump,
    size,
    executedTransactionIndex,
  };
}

/**
 * Detect transaction type by discriminator and deserialize accordingly.
 */
export function deserializeTransaction(data) {
  if (data.length < 8) throw new Error('Transaction data too short');

  const disc = data.slice(0, 8);

  if (arrayEqual(disc, VAULT_TX_DISCRIMINATOR)) {
    return deserializeVaultTransaction(data);
  }
  if (arrayEqual(disc, CONFIG_TX_DISCRIMINATOR)) {
    return deserializeConfigTransaction(data);
  }
  if (arrayEqual(disc, VAULT_BATCH_TX_DISC)) {
    return deserializeVaultBatchTransaction(data);
  }
  if (arrayEqual(disc, BATCH_DISCRIMINATOR)) {
    return deserializeBatch(data);
  }

  // Unknown type — return minimal info
  return {
    type: 'unknown',
    discriminator: toHex(disc),
    verificationErrors: ['Unknown transaction type'],
  };
}

/**
 * Return the reasons a transaction cannot be safely approved.
 */
export function getTransactionVerificationErrors(transaction) {
  if (!transaction) return ['Transaction data is unavailable'];
  return [...new Set(transaction.verificationErrors || [])];
}

function arrayEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
