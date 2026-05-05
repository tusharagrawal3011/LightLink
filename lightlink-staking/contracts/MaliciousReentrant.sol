// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IStakingVault {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/**
 * @title MaliciousReentrant
 * @notice Test helper that attempts a reentrancy attack on StakingVault.withdraw.
 *         Used only in the test suite to verify that the vault is protected against reentrancy.
 */
contract MaliciousReentrant {
    IStakingVault public immutable vault;
    uint256 public attackAmount;
    bool public attacking;

    constructor(address _vault) {
        vault = IStakingVault(_vault);
    }

    /// @notice Deposit into the vault so we have a balance to withdraw.
    function attack() external payable {
        vault.deposit{value: msg.value}();
        attackAmount = msg.value;
    }

    /// @notice Trigger the reentrant withdrawal attempt.
    function triggerWithdraw(uint256 amount) external {
        attacking = true;
        vault.withdraw(amount);
        attacking = false;
    }

    /// @notice Fallback called when ETH is received — attempts reentrant withdraw.
    receive() external payable {
        if (attacking && address(vault).balance >= attackAmount) {
            vault.withdraw(attackAmount);
        }
    }
}
