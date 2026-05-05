// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title StakingVault
 * @author LightLink Engineering
 * @notice ETH staking vault with time-based APY rewards, deployed on LightLink L2.
 *         Users deposit ETH and earn rewards proportional to their stake and time staked.
 *         The owner funds a separate reward reserve; principal and reserve are tracked
 *         independently so that accounting is never confused.
 * @dev Security model:
 *      - Checks-Effects-Interactions on every state-changing function
 *      - nonReentrant on all external functions that move ETH
 *      - ETH transfers use low-level call{value}("") — never transfer() / send()
 *      - totalStaked is maintained separately from address(this).balance
 *      - Ownable2Step prevents accidental ownership renunciation
 */
contract StakingVault is ReentrancyGuard, Pausable, Ownable2Step {

    // -------------------------------------------------------------------------
    // Custom errors (more gas-efficient than revert strings)
    // -------------------------------------------------------------------------

    /// @notice Thrown when a deposit is below the configured minimum.
    error BelowMinimumStake(uint256 sent, uint256 minimum);

    /// @notice Thrown when a withdrawal amount is zero or exceeds the user's balance.
    error InvalidWithdrawAmount(uint256 requested, uint256 available);

    /// @notice Thrown when the reward reserve cannot cover a pending payout.
    error InsufficientRewardReserve(uint256 required, uint256 available);

    /// @notice Thrown when the contract balance cannot cover principal + reward.
    error InsufficientContractBalance(uint256 required, uint256 available);

    /// @notice Thrown when an ETH transfer fails at the low-level call.
    error TransferFailed(address recipient, uint256 amount);

    /// @notice Thrown when the proposed reward rate exceeds the safety cap.
    error RewardRateTooHigh(uint256 proposed, uint256 maximum);

    /// @notice Thrown when fundRewardReserve is called with zero ETH.
    error MustSendEther();

    // -------------------------------------------------------------------------
    // State variables
    // -------------------------------------------------------------------------

    /// @notice Staked ETH balance per user (principal only, rewards excluded).
    mapping(address => uint256) public stakedBalance;

    /// @notice Timestamp of the user's last stake action or reward claim.
    ///         Used as the start of the current reward accrual window.
    mapping(address => uint256) public stakeTimestamp;

    /// @notice Accumulated rewards already paid out to each user (informational).
    mapping(address => uint256) public rewardDebt;

    /// @notice Aggregate ETH principal deposited across all active stakers.
    ///         Tracked separately from address(this).balance to avoid mixing
    ///         principal with the reward reserve.
    uint256 public totalStaked;

    /// @notice Annual reward rate expressed in basis points (1000 = 10% APY).
    uint256 public rewardRatePerYear;

    /// @notice Minimum ETH a user must send in a single deposit call.
    uint256 public minimumStake;

    /// @notice Number of seconds in a 365-day year, used for reward calculation.
    uint256 public constant SECONDS_IN_YEAR = 365 days;

    /// @notice Denominator for basis-point arithmetic (10 000 = 100%).
    uint256 public constant BASIS_POINTS = 10_000;

    /// @notice Hard cap on rewardRatePerYear (5000 bp = 50% APY).
    uint256 public constant MAX_REWARD_RATE = 5_000;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when a user successfully deposits ETH.
    /// @param user      Depositing address.
    /// @param amount    ETH deposited (msg.value).
    /// @param timestamp Block timestamp of the deposit.
    event Deposited(address indexed user, uint256 amount, uint256 timestamp);

    /// @notice Emitted when a user withdraws principal (and any accrued reward).
    /// @param user      Withdrawing address.
    /// @param principal Amount of principal returned.
    /// @param reward    Reward included in the same transfer.
    /// @param timestamp Block timestamp of the withdrawal.
    event Withdrawn(address indexed user, uint256 principal, uint256 reward, uint256 timestamp);

    /// @notice Emitted when a user claims accrued rewards without withdrawing principal.
    /// @param user      Claiming address.
    /// @param reward    ETH reward transferred.
    /// @param timestamp Block timestamp of the claim.
    event RewardClaimed(address indexed user, uint256 reward, uint256 timestamp);

    /// @notice Emitted when the owner updates the annual reward rate.
    /// @param oldRate Previous rate in basis points.
    /// @param newRate New rate in basis points.
    event RewardRateUpdated(uint256 oldRate, uint256 newRate);

    /// @notice Emitted when ETH is sent to the contract to top up the reward reserve.
    /// @param funder Address that sent the ETH.
    /// @param amount ETH received.
    event RewardReserveFunded(address indexed funder, uint256 amount);

    /// @notice Emitted when the owner drains the full contract balance in an emergency.
    /// @param owner  Owner address that triggered the emergency withdrawal.
    /// @param amount ETH transferred to the owner.
    event EmergencyWithdraw(address indexed owner, uint256 amount);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /**
     * @notice Deploys the StakingVault.
     * @param _rewardRatePerYear Initial annual reward rate in basis points (e.g. 1000 = 10%).
     * @param _minimumStake      Smallest deposit accepted in wei.
     */
    constructor(uint256 _rewardRatePerYear, uint256 _minimumStake) Ownable(msg.sender) {
        if (_rewardRatePerYear > MAX_REWARD_RATE) {
            revert RewardRateTooHigh(_rewardRatePerYear, MAX_REWARD_RATE);
        }
        rewardRatePerYear = _rewardRatePerYear;
        minimumStake = _minimumStake;
    }

    // -------------------------------------------------------------------------
    // Receive
    // -------------------------------------------------------------------------

    /**
     * @notice Accepts plain ETH transfers to grow the reward reserve.
     * @dev Any address can top up the reserve this way (not just the owner).
     *      Emits RewardReserveFunded so off-chain tooling can track inflows.
     */
    receive() external payable {
        emit RewardReserveFunded(msg.sender, msg.value);
    }

    // -------------------------------------------------------------------------
    // External — user functions
    // -------------------------------------------------------------------------

    /**
     * @notice Deposit ETH into the vault to start earning rewards.
     * @dev If the caller already has an active stake, any accrued rewards are
     *      automatically claimed before the new deposit is recorded, so the
     *      reward window resets cleanly.
     *      Checks-Effects-Interactions order is maintained throughout.
     */
    function deposit() external payable nonReentrant whenNotPaused {
        if (msg.value < minimumStake) {
            revert BelowMinimumStake(msg.value, minimumStake);
        }

        // Auto-claim pending rewards so the timestamp can safely reset.
        if (stakedBalance[msg.sender] > 0) {
            _claimReward(msg.sender);
        }

        // Effects
        stakedBalance[msg.sender] += msg.value;
        totalStaked += msg.value;
        stakeTimestamp[msg.sender] = block.timestamp;

        emit Deposited(msg.sender, msg.value, block.timestamp);
    }

    /**
     * @notice Withdraw an amount of principal plus any accrued rewards.
     * @dev Follows Checks-Effects-Interactions strictly: all storage is updated
     *      before any ETH is transferred. nonReentrant provides a second layer of
     *      protection against re-entrancy attacks.
     * @param amount Wei of principal to withdraw (must be <= stakedBalance[msg.sender]).
     */
    function withdraw(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0 || stakedBalance[msg.sender] < amount) {
            revert InvalidWithdrawAmount(amount, stakedBalance[msg.sender]);
        }

        // Checks
        uint256 reward = calculateReward(msg.sender);
        uint256 totalOut = amount + reward;
        if (address(this).balance < totalOut) {
            revert InsufficientContractBalance(totalOut, address(this).balance);
        }

        // Effects — update state BEFORE any external call
        stakedBalance[msg.sender] -= amount;
        totalStaked -= amount;
        stakeTimestamp[msg.sender] = block.timestamp;
        if (reward > 0) {
            rewardDebt[msg.sender] += reward;
        }

        emit Withdrawn(msg.sender, amount, reward, block.timestamp);

        // Interactions — transfer after all state is settled
        _safeTransferETH(msg.sender, totalOut);
    }

    /**
     * @notice Claim accrued staking rewards without touching the principal.
     * @dev Delegates to {_claimReward} which resets the reward accrual window.
     */
    function claimReward() external nonReentrant whenNotPaused {
        _claimReward(msg.sender);
    }

    // -------------------------------------------------------------------------
    // External — view functions
    // -------------------------------------------------------------------------

    /**
     * @notice Returns a user's full staking position in one call.
     * @param user        Address to query.
     * @return staked       Current principal balance.
     * @return pendingReward Reward accrued since the last claim/deposit.
     * @return stakedSince  Timestamp of the last stake action or reward claim.
     */
    function getUserInfo(address user)
        external
        view
        returns (uint256 staked, uint256 pendingReward, uint256 stakedSince)
    {
        staked = stakedBalance[user];
        pendingReward = calculateReward(user);
        stakedSince = stakeTimestamp[user];
    }

    /**
     * @notice ETH available to pay future rewards (contract balance minus principal).
     * @return reserve Wei available in the reward reserve.
     */
    function getRewardReserve() public view returns (uint256 reserve) {
        if (totalStaked >= address(this).balance) {
            return 0;
        }
        return address(this).balance - totalStaked;
    }

    // -------------------------------------------------------------------------
    // Public — pure/view
    // -------------------------------------------------------------------------

    /**
     * @notice Calculate the pending reward for a user based on elapsed time.
     * @dev Formula: principal * rate * timeStaked / (SECONDS_IN_YEAR * BASIS_POINTS)
     *      Uses integer division; small rounding losses are acceptable.
     * @param user Address to calculate reward for.
     * @return reward Wei owed to the user.
     */
    function calculateReward(address user) public view returns (uint256 reward) {
        if (stakedBalance[user] == 0) {
            return 0;
        }
        uint256 timeStaked = block.timestamp - stakeTimestamp[user];
        reward = (stakedBalance[user] * rewardRatePerYear * timeStaked) /
            (SECONDS_IN_YEAR * BASIS_POINTS);
    }

    // -------------------------------------------------------------------------
    // External — owner functions
    // -------------------------------------------------------------------------

    /**
     * @notice Update the annual reward rate.
     * @dev The new rate applies to the time elapsed from each user's next interaction
     *      onward. Existing accrued rewards use the old rate implicitly because
     *      _claimReward is called before the rate changes (if the user interacts).
     * @param newRate New rate in basis points. Must be <= MAX_REWARD_RATE (5000).
     */
    function setRewardRate(uint256 newRate) external onlyOwner {
        if (newRate > MAX_REWARD_RATE) {
            revert RewardRateTooHigh(newRate, MAX_REWARD_RATE);
        }
        uint256 oldRate = rewardRatePerYear;
        rewardRatePerYear = newRate;
        emit RewardRateUpdated(oldRate, newRate);
    }

    /**
     * @notice Top up the reward reserve by sending ETH with this call.
     * @dev Owner-only convenience wrapper; the receive() fallback also accepts ETH.
     */
    function fundRewardReserve() external payable onlyOwner {
        if (msg.value == 0) revert MustSendEther();
        emit RewardReserveFunded(msg.sender, msg.value);
    }

    /**
     * @notice Drain the entire contract balance to the owner in an emergency.
     * @dev Callable even when the contract is paused, so the owner can always
     *      recover funds after pausing in response to an incident.
     *      NOTE: This will also pull staker principal — intended only as a last resort.
     */
    function emergencyWithdraw() external onlyOwner {
        uint256 amount = address(this).balance;
        // Effects before interaction
        totalStaked = 0;

        emit EmergencyWithdraw(msg.sender, amount);

        _safeTransferETH(msg.sender, amount);
    }

    /**
     * @notice Pause all user-facing deposit, withdraw, and claim functions.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Resume normal operations after a pause.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * @notice Compute and transfer accrued rewards to a user, then reset their window.
     * @dev Called internally by deposit() (auto-claim) and claimReward().
     *      CEI is maintained: timestamp is reset before the ETH call.
     * @param user Address receiving the reward.
     */
    function _claimReward(address user) internal {
        uint256 reward = calculateReward(user);
        if (reward == 0) return;

        uint256 reserve = getRewardReserve();
        if (reserve < reward) {
            revert InsufficientRewardReserve(reward, reserve);
        }

        // Effects — reset window BEFORE the transfer
        stakeTimestamp[user] = block.timestamp;
        rewardDebt[user] += reward;

        emit RewardClaimed(user, reward, block.timestamp);

        // Interaction
        _safeTransferETH(user, reward);
    }

    /**
     * @notice Transfer ETH using a low-level call; revert on failure.
     * @dev Avoids transfer() / send() which have fixed 2300 gas stipends that
     *      can break with EIP-1884 / smart-contract recipients.
     * @param recipient Address to send ETH to.
     * @param amount    Wei to transfer.
     */
    function _safeTransferETH(address recipient, uint256 amount) internal {
        (bool success, ) = recipient.call{value: amount}("");
        if (!success) revert TransferFailed(recipient, amount);
    }
}
