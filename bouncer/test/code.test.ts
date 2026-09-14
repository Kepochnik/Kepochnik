import assert from "node:assert/strict";
import { test } from "node:test";
import { scanBytecode, storageWordAddress, storageWordIsSet } from "../src/chain/code.js";
import { DEMO_CODE } from "../src/bouncer/demo.js";

test("PUSH immediates are not opcodes", () => {
  // PUSH32 with 0xff and 0xf4 inside, then STOP.
  const scan = scanBytecode(`0x7f${"ff".repeat(16)}${"f4".repeat(16)}00`);
  assert.equal(scan.opcodes.selfdestruct, 0);
  assert.equal(scan.opcodes.delegatecall, 0);
  assert.equal(scan.bytes, 34);
  assert.equal(scan.empty, false);
});

test("the Solidity metadata trailer is skipped", () => {
  const scan = scanBytecode(DEMO_CODE.ponsToken);
  assert.equal(scan.metadataBytes, 55);
  assert.deepEqual(scan.opcodes, { selfdestruct: 0, delegatecall: 0, callcode: 0, create: 0, create2: 0 });
});

test("real SELFDESTRUCT and DELEGATECALL are counted once each", () => {
  const scan = scanBytecode(DEMO_CODE.impostor);
  assert.equal(scan.opcodes.selfdestruct, 1);
  assert.equal(scan.opcodes.delegatecall, 1);
});

test("an EIP-1167 minimal proxy names its target", () => {
  const target = "1234567890123456789012345678901234567890";
  const scan = scanBytecode(`0x363d3d373d3d3d363d73${target}5af43d82803e903d91602b57fd5bf3`);
  assert.equal(scan.minimalProxyTarget, `0x${target}`);
  assert.equal(scan.opcodes.delegatecall, 1);
});

test("empty code is an EOA", () => {
  const scan = scanBytecode("0x");
  assert.equal(scan.empty, true);
  assert.equal(scan.bytes, 0);
});

test("storage words", () => {
  assert.equal(storageWordIsSet(`0x${"0".repeat(64)}`), false);
  assert.equal(storageWordIsSet(`0x${"0".repeat(24)}${"ab".repeat(20)}`), true);
  assert.equal(storageWordAddress(`0x${"0".repeat(24)}${"ab".repeat(20)}`), `0x${"ab".repeat(20)}`);
});
