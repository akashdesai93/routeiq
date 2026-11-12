/**
 * The version of the core contracts (PLAN step 10, #7): the shapes the Swift
 * port (native/RouteIQCore) and the iPhone shell depend on. See
 * docs/contracts.md for what is in the contract and how to change it.
 *
 * Bump it whenever one of those shapes changes, however small (a field added,
 * removed, renamed, made optional, a word added to a union), then regenerate
 * docs/contracts/core-contract.json:
 *
 *   UPDATE_CONTRACT=1 npx vitest run tests/contracts.test.ts
 *
 * tests/contracts.test.ts fails on a change of shape without a bump. Only
 * shapes are covered: a default value or a rule changing is covered by the
 * unit tests that pin it (the spec for the port), not by this number.
 */
export const CORE_CONTRACT_VERSION = 6
