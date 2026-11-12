import Foundation

/// The version of the web app's core contracts (`CORE_CONTRACT_VERSION` in
/// src/core/contract.ts, docs/contracts.md) that this port was brought up to.
/// When the web app bumps its version, compare docs/contracts/core-contract.json
/// (`declarations`) with the Swift types, port what changed, then raise this
/// number to match. See the README for which parts of the contract are ported.
public enum Contract {
    public static let coreContractVersion = 3
}
