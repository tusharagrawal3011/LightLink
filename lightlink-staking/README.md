# LightLink Staking Vault

A quality ETH staking vault deployed on [LightLink L2](https://lightlink.io) (EVM-compatible, gasless enterprise transactions). Users deposit ETH and earn time-proportional APY rewards funded by a separate on-chain reserve maintained by the contract owner.

---

## Architecture

```
                        ┌─────────────────────────────────┐
                        │         StakingVault.sol         │
                        │                                  │
  User ──deposit()───►  │  stakedBalance[user] += amount   │
                        │  totalStaked        += amount    │
                        │  stakeTimestamp[user] = now      │
                        │                                  │
  User ──withdraw()──►  │  reward = calculateReward(user)  │
       ◄── ETH ──────   │  state updated BEFORE transfer   │
                        │  (CEI pattern)                   │
                        │                                  │
  User ──claimReward()► │  timestamp reset BEFORE transfer │
       ◄── reward ETH─  │  (CEI pattern)                   │
                        │                                  │
  Owner─fundReserve()►  │  reward reserve grows            │
                        │  reserve = balance - totalStaked │
                        └─────────────────────────────────┘

  Reward formula:
  reward = principal × rewardRatePerYear × timeStaked
           ─────────────────────────────────────────
                    SECONDS_IN_YEAR × 10_000
```

---

## Security Measures

| Protection | Implementation |
|---|---|
| Reentrancy | `nonReentrant` (OpenZeppelin) on all ETH-moving externals |
| CEI pattern | State updated before every `call{value}` |
| Safe ETH transfer | `call{value: amount}("")` — never `transfer()` / `send()` |
| Principal / reserve separation | `totalStaked` tracked independently from `address(this).balance` |
| Reward solvency check | `getRewardReserve()` checked before every payout |
| Safe ownership transfer | `Ownable2Step` — two-step confirmation prevents accidents |
| Pause mechanism | `Pausable` — emergency stop for deposits / withdrawals / claims |
| Reward rate cap | Hard cap at 5 000 bp (50% APY) via `MAX_REWARD_RATE` |
| Minimum deposit | Configurable `minimumStake` prevents dust attacks |
| Custom errors | Gas-efficient revert reasons for all failure modes |

---

## Setup

```bash
# 1. Clone and enter the project
git clone <repo-url>
cd lightlink-staking

# 2. Install dependencies
npm install

# 3. Copy and populate environment variables
cp .env.example .env
# Edit .env — set PRIVATE_KEY (no 0x prefix needed, but accepted)

# 4. Compile
npx hardhat compile
```

---

## Deploy

### Pegasus Testnet (chainId 1891)

```bash
npx hardhat run scripts/deploy.js --network lightlink_pegasus
```

### Phoenix Mainnet (chainId 1890)

```bash
npx hardhat run scripts/deploy.js --network lightlink_phoenix
```

The deploy script:
- Deploys `StakingVault` with 10% APY and 0.01 ETH minimum stake
- Funds the reward reserve with 0.1 ETH
- Saves the contract address to `deployments.json`

### Verify on block explorer

```bash
npx hardhat verify --network lightlink_pegasus <CONTRACT_ADDRESS> 1000 10000000000000000
```

---

## Test

```bash
# Run all tests
npx hardhat test

# Run with gas report
REPORT_GAS=true npx hardhat test

# Coverage
npx hardhat coverage
```

---

## Interact

After deploying, run the full demo flow:

```bash
npx hardhat run scripts/interact.js --network lightlink_pegasus
```

The script demonstrates: initial state → deposit → getUserInfo → calculateReward → claimReward → withdraw → final state.

---

## Contract Functions Reference

| Function | Params | Description | Access |
|---|---|---|---|
| `deposit()` | `payable` | Stake ETH; auto-claims if already staked | Public |
| `withdraw(amount)` | `uint256 amount` | Withdraw principal + accrued reward | Public |
| `claimReward()` | — | Claim accrued reward, keep principal staked | Public |
| `calculateReward(user)` | `address user` | View pending reward in wei | View |
| `getUserInfo(user)` | `address user` | Returns staked, pendingReward, stakedSince | View |
| `getRewardReserve()` | — | ETH available for reward payouts | View |
| `setRewardRate(newRate)` | `uint256 newRate` | Update APY (max 5000 bp) | Owner |
| `fundRewardReserve()` | `payable` | Top up reward reserve | Owner |
| `emergencyWithdraw()` | — | Drain all ETH to owner (last resort) | Owner |
| `pause()` | — | Pause user-facing functions | Owner |
| `unpause()` | — | Resume normal operation | Owner |
| `transferOwnership(addr)` | `address` | Step 1 of 2-step ownership transfer | Owner |
| `acceptOwnership()` | — | Step 2 — new owner accepts | Pending owner |

---

## Known Tradeoffs

**`block.timestamp` manipulation**
Miners / validators can nudge `block.timestamp` by a few seconds. For short staking windows (seconds to minutes) this could slightly inflate or deflate rewards. At the scale of days-to-years the impact is negligible. An oracle-based time source would mitigate this at the cost of external dependency.

**Centralisation of owner key**
`emergencyWithdraw` lets the owner drain all funds including user principal. This is intentional for emergency recovery but creates a trust assumption. Mitigations for production: multisig (Gnosis Safe), timelock controller, or DAO governance over the owner role.

**Single reward rate**
All stakers earn the same APY regardless of lock-up duration. A tiered model (longer lock = higher rate) would improve capital efficiency but adds significant complexity.

**No reward auto-compounding**
Claimed rewards are sent as ETH, not re-staked automatically. A `compound()` function could be added without breaking the current model.

---

## License

MIT
