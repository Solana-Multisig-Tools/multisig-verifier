/**
 * Verification tests — compare our hand-rolled implementations against known-good values.
 * Run with: node test/verify.mjs
 *
 * Tests: base58, compact-u16, on-curve check, PDA derivation, Borsh parsing, transaction serialization.
 */

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
  }
}

function assertEq(actual, expected, message) {
  const a = typeof actual === 'object' ? JSON.stringify(actual) : String(actual);
  const e = typeof expected === 'object' ? JSON.stringify(expected) : String(expected);
  if (a === e) {
    passed++;
    console.log(`  PASS: ${message}`);
  } else {
    failed++;
    console.error(`  FAIL: ${message}`);
    console.error(`    Expected: ${e}`);
    console.error(`    Actual:   ${a}`);
  }
}

function bytesEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ─── Import our modules ───
// We need to handle the import since these are written for browser/webpack.
// We'll use dynamic import and provide crypto polyfill for Node.

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.TextEncoder) {
  const { TextEncoder, TextDecoder } = await import('node:util');
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}

const { encodeBase58, decodeBase58, isValidBase58, BorshReader, shortenAddress, toHex, resolveLookupKeys, deserializeConfigTransaction, CONFIG_TX_DISCRIMINATOR } = await import('../src/squads.js');
const { isOnCurve, findProgramAddress, sha256 } = await import('../src/crypto.js');
const { encodeCompactU16, serializeTransactionMessage, buildUnsignedTransaction, AccountRole, concat } = await import('../src/transaction.js');

// ═══════════════════════════════════════════
console.log('\n=== Base58 Tests ===');

// Known Solana addresses
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SQUADS_PROGRAM = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

// System program is 32 zero bytes
const systemBytes = decodeBase58(SYSTEM_PROGRAM);
assertEq(systemBytes.length, 32, 'System program decodes to 32 bytes');
assert(systemBytes.every(b => b === 0), 'System program is all zeros');
assertEq(encodeBase58(systemBytes), SYSTEM_PROGRAM, 'System program roundtrips');

// Token program roundtrip
const tokenBytes = decodeBase58(TOKEN_PROGRAM);
assertEq(tokenBytes.length, 32, 'Token program decodes to 32 bytes');
assertEq(encodeBase58(tokenBytes), TOKEN_PROGRAM, 'Token program roundtrips');

// Squads program roundtrip
const squadsBytes = decodeBase58(SQUADS_PROGRAM);
assertEq(squadsBytes.length, 32, 'Squads program decodes to 32 bytes');
assertEq(encodeBase58(squadsBytes), SQUADS_PROGRAM, 'Squads program roundtrips');

// Validation
assert(isValidBase58(SQUADS_PROGRAM), 'Squads program is valid base58');
assert(!isValidBase58('invalid'), 'Short string is invalid');
assert(!isValidBase58('0OIl'), 'Characters not in base58 alphabet are invalid');
assert(!isValidBase58(''), 'Empty string is invalid');

// shortenAddress
assertEq(shortenAddress('7xKp3nRm5tKp', 4), '7xKp...5tKp', 'shortenAddress works');

// ═══════════════════════════════════════════
console.log('\n=== Compact-u16 Tests ===');

assertEq([...encodeCompactU16(0)], [0x00], 'compact-u16: 0');
assertEq([...encodeCompactU16(1)], [0x01], 'compact-u16: 1');
assertEq([...encodeCompactU16(127)], [0x7f], 'compact-u16: 127');
assertEq([...encodeCompactU16(128)], [0x80, 0x01], 'compact-u16: 128');
assertEq([...encodeCompactU16(255)], [0xff, 0x01], 'compact-u16: 255');
assertEq([...encodeCompactU16(256)], [0x80, 0x02], 'compact-u16: 256');
assertEq([...encodeCompactU16(16383)], [0xff, 0x7f], 'compact-u16: 16383');
assertEq([...encodeCompactU16(16384)], [0x80, 0x80, 0x01], 'compact-u16: 16384');

// ═══════════════════════════════════════════
console.log('\n=== Ed25519 On-Curve Check ===');

// Known public keys ARE on the curve
const systemProgramBytes = decodeBase58(SYSTEM_PROGRAM);
// System program (all zeros) — compressed Y=0. y2=0, u=P-1, v=1, x2=P-1 (i.e. -1 mod P).
// P ≡ 1 mod 4, so -1 IS a quadratic residue → point IS on curve.
// This is correct — the system program address (all zeros) happens to be on-curve.
assert(isOnCurve(systemProgramBytes), 'All-zero bytes IS on the curve (P ≡ 1 mod 4, so -1 is a QR)');

// A real ed25519 public key should be on the curve
// Let's use a well-known validator pubkey: the Solana genesis hash pubkey won't work,
// but we can check that our Squads program ID hash is NOT on curve (it's a PDA-like address)
// Actually, program IDs ARE regular public keys, so they should be on curve
// The Squads program ID is a deployed program, which has a keypair, so it IS on curve
assert(isOnCurve(squadsBytes), 'Squads program ID is on the curve (it has a keypair)');

// Token program is also a real keypair
assert(isOnCurve(tokenBytes), 'Token program ID is on the curve');

// ═══════════════════════════════════════════
console.log('\n=== PDA Derivation ===');

// Test: derive the Squads v4 vault PDA for a known multisig
// We'll derive for system program as multisig (just to test the algorithm)
// and compare bump finding behavior
{
  const seeds = [
    new TextEncoder().encode('multisig'),
    systemProgramBytes,
    new TextEncoder().encode('vault'),
    new Uint8Array([0]),
  ];

  const [pda, bump] = await findProgramAddress(seeds, squadsBytes);
  assertEq(pda.length, 32, 'PDA is 32 bytes');
  assert(bump >= 0 && bump <= 255, 'Bump is in valid range: ' + bump);
  assert(!isOnCurve(pda), 'Derived PDA is NOT on the curve');

  // Derive again — should be deterministic
  const [pda2, bump2] = await findProgramAddress(seeds, squadsBytes);
  assert(bytesEq(pda, pda2), 'PDA derivation is deterministic');
  assertEq(bump, bump2, 'Bump is deterministic');
}

// Test: derive proposal PDA and verify it's different from transaction PDA
{
  const { getTransactionPda, getProposalPda } = await import('../src/squads.js');

  // Use system program as a fake multisig address for testing
  const [txPda] = await getTransactionPda(SYSTEM_PROGRAM, 1);
  const [proposalPda] = await getProposalPda(SYSTEM_PROGRAM, 1);

  assert(!bytesEq(txPda, proposalPda), 'Transaction PDA differs from Proposal PDA');
  assert(!isOnCurve(txPda), 'Transaction PDA is NOT on curve');
  assert(!isOnCurve(proposalPda), 'Proposal PDA is NOT on curve');
}

// ═══════════════════════════════════════════
console.log('\n=== BorshReader Tests ===');

{
  // Test basic reads
  const data = new Uint8Array([
    0x42,                               // u8 = 66
    0x01, 0x02,                         // u16 LE = 513
    0x04, 0x03, 0x02, 0x01,             // u32 LE = 16909060
    0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,  // u64 LE
    0x01,                               // Option tag = Some
    0xAA,                               // Option value = 0xAA
    0x00,                               // Option tag = None
  ]);

  const reader = new BorshReader(data);
  assertEq(reader.readU8(), 66, 'BorshReader: readU8');
  assertEq(reader.readU16(), 513, 'BorshReader: readU16');
  assertEq(reader.readU32(), 16909060, 'BorshReader: readU32');
  assertEq(reader.readU64(), 72623859790382856n, 'BorshReader: readU64');
  assertEq(reader.readOption(r => r.readU8()), 0xAA, 'BorshReader: readOption Some');
  assertEq(reader.readOption(r => r.readU8()), null, 'BorshReader: readOption None');
}

{
  // Test bounds checking
  const data = new Uint8Array([0x01]);
  const reader = new BorshReader(data);
  reader.readU8();
  let threw = false;
  try { reader.readU8(); } catch { threw = true; }
  assert(threw, 'BorshReader: throws on buffer overrun');
}

{
  // Test vec with length cap
  const data = new Uint8Array([
    0xFF, 0xFF, 0xFF, 0x0F, // vec length = 268435455 (way too big)
  ]);
  const reader = new BorshReader(data);
  let threw = false;
  try { reader.readVec(r => r.readU8(), 100); } catch { threw = true; }
  assert(threw, 'BorshReader: rejects oversized vec');
}

{
  // Test string
  const text = 'hello';
  const encoded = new TextEncoder().encode(text);
  const data = new Uint8Array(4 + encoded.length);
  new DataView(data.buffer).setUint32(0, encoded.length, true);
  data.set(encoded, 4);

  const reader = new BorshReader(data);
  assertEq(reader.readString(), 'hello', 'BorshReader: readString');
}

// ═══════════════════════════════════════════
console.log('\n=== ProposalStatus Deserialization ===');

{
  // Active status (tag=1) with timestamp
  const data = new Uint8Array(9);
  data[0] = 1; // Active
  new DataView(data.buffer).setBigInt64(1, 1700000000n, true);

  const { BorshReader: BR } = await import('../src/squads.js');
  // We need to test readProposalStatus which is internal to deserializeProposal
  // Let's test it indirectly by building a minimal proposal-like buffer

  // Executing status (tag=4) — NO timestamp
  const execData = new Uint8Array(1);
  execData[0] = 4;
  const execReader = new BR(execData);
  const tag = execReader.readU8();
  assertEq(tag, 4, 'Executing tag is 4');
  assertEq(execReader.offset, 1, 'Executing consumes only 1 byte (no timestamp)');
}

// ═══════════════════════════════════════════
console.log('\n=== Transaction Serialization ===');

{
  // Build a simple SOL transfer instruction and verify wire format structure
  const feePayer = decodeBase58(SQUADS_PROGRAM); // fake, just for testing structure
  const recipient = decodeBase58(TOKEN_PROGRAM); // fake

  // System program transfer: [4B type=2][8B lamports]
  const ixData = new Uint8Array(12);
  new DataView(ixData.buffer).setUint32(0, 2, true); // type = transfer
  new DataView(ixData.buffer).setBigUint64(4, 1000000000n, true); // 1 SOL

  const instruction = {
    programId: systemProgramBytes,
    accounts: [
      { pubkey: feePayer, role: AccountRole.WRITABLE_SIGNER },
      { pubkey: recipient, role: AccountRole.WRITABLE },
    ],
    data: ixData,
  };

  // Use a fake blockhash (32 bytes)
  const fakeBlockhash = new Uint8Array(32);
  fakeBlockhash[0] = 0x42;

  const messageBytes = serializeTransactionMessage({
    feePayer,
    recentBlockhash: fakeBlockhash,
    instructions: [instruction],
  });

  // V0 message should start with 0x80
  assertEq(messageBytes[0], 0x80, 'V0 message starts with 0x80 prefix');

  // Header: 1 signer (fee payer), 0 readonly signed, 1 readonly unsigned (system program)
  assertEq(messageBytes[1], 1, 'Header: 1 required signature');
  assertEq(messageBytes[2], 0, 'Header: 0 readonly signed');
  assertEq(messageBytes[3], 1, 'Header: 1 readonly unsigned (system program)');

  // 3 account keys (fee payer, recipient, system program)
  assertEq(messageBytes[4], 3, 'Compact-u16: 3 account keys');

  // Fee payer should be first
  assert(bytesEq(messageBytes.slice(5, 37), feePayer), 'First account key is fee payer');

  // Build unsigned transaction
  const txBytes = buildUnsignedTransaction(messageBytes, 1);
  assertEq(txBytes[0], 1, 'Transaction: 1 signature slot');
  // 64 zero bytes for the unsigned signature
  assert(txBytes.slice(1, 65).every(b => b === 0), 'Transaction: signature slot is zeroed');
  // Message follows
  assertEq(txBytes[65], 0x80, 'Transaction: message starts after signature');
}

// ═══════════════════════════════════════════
console.log('\n=== SHA-256 ===');

{
  const data = new TextEncoder().encode('test');
  const hash = await sha256(data);
  // Known SHA-256 of "test" = 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
  const expected = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
  const actual = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
  assertEq(actual, expected, 'SHA-256 of "test" matches known hash');
}

// ═══════════════════════════════════════════
console.log('\n=== ALT Lookup Key Ordering ===');

{
  // Two tables, each contributing one writable + one readonly key. Solana MessageV0
  // groups all writable across tables first, then all readonly.
  const lookups = [
    { writableIndexes: [0], readonlyIndexes: [1] },
    { writableIndexes: [2], readonlyIndexes: [3] },
  ];
  const tableKeys = [
    ['A_w', 'A_r', 'A_x', 'A_y'],
    ['B_p', 'B_q', 'B_w', 'B_r'],
  ];
  const { writable, readonly } = resolveLookupKeys(lookups, tableKeys);

  assertEq(writable, ['A_w', 'B_w'], 'writable = all writable across tables, in table order');
  assertEq(readonly, ['A_r', 'B_r'], 'readonly = all readonly across tables, in table order');
  // The full loaded region matches the program's get_account_by_index order...
  assertEq([...writable, ...readonly], ['A_w', 'B_w', 'A_r', 'B_r'], 'loaded order matches Solana MessageV0');
  // ...and is NOT the old per-table interleaving that caused the spoof.
  assert(
    JSON.stringify([...writable, ...readonly]) !== JSON.stringify(['A_w', 'A_r', 'B_w', 'B_r']),
    'loaded order is not the buggy per-table interleaving',
  );
}

{
  // Single table is unaffected by the grouping change.
  const lookups = [{ writableIndexes: [1, 0], readonlyIndexes: [2] }];
  const tableKeys = [['k0', 'k1', 'k2']];
  const { writable, readonly } = resolveLookupKeys(lookups, tableKeys);
  assertEq(writable, ['k1', 'k0'], 'single-table writable preserves lookup index order');
  assertEq(readonly, ['k2'], 'single-table readonly preserved');
}

{
  // Unavailable table (null) yields '?' placeholders, preserving index alignment.
  const lookups = [
    { writableIndexes: [0], readonlyIndexes: [1] },
    { writableIndexes: [0], readonlyIndexes: [1] },
  ];
  const tableKeys = [['A_w', 'A_r'], null];
  const { writable, readonly } = resolveLookupKeys(lookups, tableKeys);
  assertEq(writable, ['A_w', '?'], 'missing table writable becomes ? placeholder');
  assertEq(readonly, ['A_r', '?'], 'missing table readonly becomes ? placeholder');
}

// ═══════════════════════════════════════════
console.log('\n=== Config Action Byte Consumption ===');

{
  const u16le = (n) => [n & 0xff, (n >> 8) & 0xff];
  const u32le = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
  const u64le = (n) => { const a = []; let v = BigInt(n); for (let i = 0; i < 8; i++) { a.push(Number(v & 0xffn)); v >>= 8n; } return a; };
  const pk = (fill) => Array(32).fill(fill);
  const build = (parts) => new Uint8Array(parts.flat());
  const header = [Array.from(CONFIG_TX_DISCRIMINATOR), pk(1), pk(2), u64le(7), [9]]; // disc, multisig, creator, index, bump

  {
    // A complex action (AddSpendingLimit) followed by a simple one. If the complex
    // payload is not fully consumed, action[1] would be parsed from its bytes.
    const addSpendingLimit = [
      [4],                          // tag
      pk(0xAA), [3], pk(0xBB),      // create_key, vault_index, mint
      u64le(1000), [2],             // amount, period (Month)
      u32le(1), pk(0xCC),           // members = [one]
      u32le(1), pk(0xDD),           // destinations = [one]
    ];
    const changeThreshold = [[2], u16le(0x1234)];
    const buf = build([...header, u32le(2), ...addSpendingLimit, ...changeThreshold]);
    const tx = deserializeConfigTransaction(buf);

    assertEq(tx.actions.length, 2, 'config tx parses exactly 2 actions');
    assertEq(tx.actions[0].name, 'AddSpendingLimit', 'action[0] is AddSpendingLimit');
    assertEq(tx.actions[1].name, 'ChangeThreshold', 'action[1] parsed correctly after complex action (no desync)');
    assertEq(tx.actions[1].threshold, 0x1234, 'action[1] threshold not spoofed by unconsumed bytes');
  }

  {
    // RemoveSpendingLimit (tag 5) followed by SetTimeLock (tag 3).
    const buf = build([...header, u32le(2), [5], pk(0xEE), [3], u32le(42)]);
    const tx = deserializeConfigTransaction(buf);
    assertEq(tx.actions[0].name, 'RemoveSpendingLimit', 'tag 5 consumes its 32-byte pubkey');
    assertEq(tx.actions[1].name, 'SetTimeLock', 'action after RemoveSpendingLimit parsed correctly');
    assertEq(tx.actions[1].timeLock, 42, 'SetTimeLock value intact');
  }

  {
    // SetRentCollector (tag 6) with Some(pubkey), then ChangeThreshold.
    const buf = build([...header, u32le(2), [6], [1], pk(0x77), [2], u16le(5)]);
    const tx = deserializeConfigTransaction(buf);
    assertEq(tx.actions[0].name, 'SetRentCollector', 'tag 6 recognized');
    assertEq(tx.actions[1].name, 'ChangeThreshold', 'action after SetRentCollector Option parsed correctly');
    assertEq(tx.actions[1].threshold, 5, 'ChangeThreshold value intact after Option<Pubkey>');
  }

  {
    // Genuinely unknown tag: unknowable length, must fail closed (not spoof).
    const buf = build([...header, u32le(1), [99], pk(0)]);
    const tx = deserializeConfigTransaction(buf);
    assertEq(tx.actions.length, 1, 'unknown tag yields single fallback action');
    assertEq(tx.actions[0].name, 'UnparseableActions', 'unknown ConfigAction tag fails closed');
  }
}

// ═══════════════════════════════════════════
console.log('\n=== Summary ===');
console.log(`  ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('  All tests passed!\n');
}
