/**
 * The version of the core contracts (PLAN step 10, #7): the shapes the Swift
 * port (native/RouteIQCore) and the iPhone shell depend on. See
 * docs/contracts.md for what is in the contract and how to change it.
 *
 * A pull request that changes one of those shapes, however small (a field
 * added, removed, renamed, made optional, a word added to a union), does NOT
 * bump it (#169). It regenerates docs/contracts/core-contract.json and adds
 * docs/contracts/changes/<branch>.md saying what changed:
 *
 *   UPDATE_CONTRACT=1 npx vitest run tests/contracts.test.ts
 *
 * The number goes up once, in the pull request that brings the Swift port up to
 * the web contract (it bumps Contract.swift too). tests/contracts.test.ts fails
 * on an undescribed change of shape. Only
 * shapes are covered: a default value or a rule changing is covered by the
 * unit tests that pin it (the spec for the port), not by this number.
 */
export const CORE_CONTRACT_VERSION = 6
