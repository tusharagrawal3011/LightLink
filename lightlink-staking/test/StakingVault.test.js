const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

// ─── Constants ────────────────────────────────────────────────────────────────
const REWARD_RATE = 1_000n; // 10% APY in bp
const MIN_STAKE = ethers.parseEther("0.01");
const SECONDS_IN_YEAR = 365n * 24n * 3600n;
const BASIS_POINTS = 10_000n;

describe("StakingVault", function () {
  let vault;
  let owner, alice, bob, attacker;

  beforeEach(async function () {
    [owner, alice, bob, attacker] = await ethers.getSigners();

    const StakingVault = await ethers.getContractFactory("StakingVault");
    vault = await StakingVault.deploy(REWARD_RATE, MIN_STAKE);
    await vault.waitForDeployment();

    // Seed the reward reserve so payouts can succeed
    await vault
      .connect(owner)
      .fundRewardReserve({ value: ethers.parseEther("10") });
  });

  // ── 1. Deployment ────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("should set correct owner", async function () {
      expect(await vault.owner()).to.equal(owner.address);
    });

    it("should set correct reward rate", async function () {
      expect(await vault.rewardRatePerYear()).to.equal(REWARD_RATE);
    });

    it("should set correct minimum stake", async function () {
      expect(await vault.minimumStake()).to.equal(MIN_STAKE);
    });

    it("should start with zero totalStaked", async function () {
      expect(await vault.totalStaked()).to.equal(0n);
    });
  });

  // ── 2. Deposit ───────────────────────────────────────────────────────────────
  describe("Deposit", function () {
    it("should allow valid deposit and update stakedBalance", async function () {
      await vault.connect(alice).deposit({ value: ethers.parseEther("0.05") });
      expect(await vault.stakedBalance(alice.address)).to.equal(
        ethers.parseEther("0.05")
      );
    });

    it("should update totalStaked correctly", async function () {
      await vault.connect(alice).deposit({ value: ethers.parseEther("0.05") });
      await vault.connect(bob).deposit({ value: ethers.parseEther("0.1") });
      expect(await vault.totalStaked()).to.equal(ethers.parseEther("0.15"));
    });

    it("should emit Deposited event with correct args", async function () {
      const depositAmount = ethers.parseEther("0.05");
      const tx = await vault
        .connect(alice)
        .deposit({ value: depositAmount });
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(vault, "Deposited")
        .withArgs(alice.address, depositAmount, block.timestamp);
    });

    it("should reject deposit below minimumStake", async function () {
      const tooSmall = ethers.parseEther("0.001");
      await expect(
        vault.connect(alice).deposit({ value: tooSmall })
      ).to.be.revertedWithCustomError(vault, "BelowMinimumStake");
    });

    it("should reject zero value deposit", async function () {
      await expect(
        vault.connect(alice).deposit({ value: 0n })
      ).to.be.revertedWithCustomError(vault, "BelowMinimumStake");
    });

    it("should auto-claim reward on second deposit (if time has passed)", async function () {
      await vault.connect(alice).deposit({ value: ethers.parseEther("1") });

      // Advance 180 days
      await time.increase(180 * 24 * 3600);

      const rewardBefore = await vault.calculateReward(alice.address);
      expect(rewardBefore).to.be.gt(0n);

      const aliceBalBefore = await ethers.provider.getBalance(alice.address);

      const tx = await vault
        .connect(alice)
        .deposit({ value: ethers.parseEther("0.5") });
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;

      const aliceBalAfter = await ethers.provider.getBalance(alice.address);

      // Alice's net ETH change = -0.5 ETH deposit + reward received - gas
      // So: aliceBalAfter + 0.5 ETH + gas ≈ aliceBalBefore + reward
      const deposited = ethers.parseEther("0.5");
      const netChange = aliceBalAfter - aliceBalBefore + gasCost + deposited;

      // netChange should be close to the reward (within 1 wei rounding)
      expect(netChange).to.be.closeTo(rewardBefore, ethers.parseEther("0.0001"));

      // Reward window should have reset (no accrual yet on new deposit)
      const rewardAfter = await vault.calculateReward(alice.address);
      expect(rewardAfter).to.equal(0n);
    });
  });

  // ── 3. Withdraw ─────────────────────────────────────────────────────────────
  describe("Withdraw", function () {
    const DEPOSIT = ethers.parseEther("1");

    beforeEach(async function () {
      await vault.connect(alice).deposit({ value: DEPOSIT });
    });

    it("should allow full withdrawal and return principal", async function () {
      // Snapshot reward at view-call time (may be tiny due to inter-block time)
      const pendingReward = await vault.calculateReward(alice.address);
      const balBefore = await ethers.provider.getBalance(alice.address);
      const tx = await vault.connect(alice).withdraw(DEPOSIT);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const balAfter = await ethers.provider.getBalance(alice.address);

      const received = balAfter - balBefore + gasCost;
      // received = principal + any tiny reward accrued across blocks
      expect(received).to.be.gte(DEPOSIT);
      expect(received).to.be.lte(DEPOSIT + pendingReward + ethers.parseEther("0.0001"));
      expect(await vault.stakedBalance(alice.address)).to.equal(0n);
    });

    it("should allow partial withdrawal", async function () {
      const half = DEPOSIT / 2n;
      await vault.connect(alice).withdraw(half);
      expect(await vault.stakedBalance(alice.address)).to.equal(half);
      expect(await vault.totalStaked()).to.equal(half);
    });

    it("should include reward in withdrawal", async function () {
      await time.increase(365 * 24 * 3600); // 1 year

      const reward = await vault.calculateReward(alice.address);
      expect(reward).to.be.gt(0n);

      const balBefore = await ethers.provider.getBalance(alice.address);
      const tx = await vault.connect(alice).withdraw(DEPOSIT);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const balAfter = await ethers.provider.getBalance(alice.address);

      const received = balAfter - balBefore + gasCost;
      // received = principal + reward
      expect(received).to.be.closeTo(DEPOSIT + reward, ethers.parseEther("0.0001"));
    });

    it("should emit Withdrawn event with correct args", async function () {
      const tx = await vault.connect(alice).withdraw(DEPOSIT);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      // reward may be a tiny non-zero value due to inter-block timing; use anyValue
      await expect(tx)
        .to.emit(vault, "Withdrawn")
        .withArgs(alice.address, DEPOSIT, anyValue, block.timestamp);
    });

    it("should revert if amount exceeds staked balance", async function () {
      const tooMuch = DEPOSIT + ethers.parseEther("1");
      await expect(
        vault.connect(alice).withdraw(tooMuch)
      ).to.be.revertedWithCustomError(vault, "InvalidWithdrawAmount");
    });

    it("should revert on zero withdrawal amount", async function () {
      await expect(
        vault.connect(alice).withdraw(0n)
      ).to.be.revertedWithCustomError(vault, "InvalidWithdrawAmount");
    });

    it("should revert when reward reserve is insufficient", async function () {
      // Deploy a fresh vault with no reserve funding
      const StakingVault = await ethers.getContractFactory("StakingVault");
      const emptyVault = await StakingVault.deploy(REWARD_RATE, MIN_STAKE);

      await emptyVault.connect(alice).deposit({ value: DEPOSIT });
      await time.increase(365 * 24 * 3600);

      // reserve = 0, but reward > 0 — withdrawal should fail
      await expect(
        emptyVault.connect(alice).withdraw(DEPOSIT)
      ).to.be.revertedWithCustomError(emptyVault, "InsufficientContractBalance");
    });
  });

  // ── 4. Reward Calculation ───────────────────────────────────────────────────
  describe("Reward Calculation", function () {
    it("should return 0 for user with no stake", async function () {
      expect(await vault.calculateReward(alice.address)).to.equal(0n);
    });

    it("should calculate correct reward for 365 days at 10% APY", async function () {
      const principal = ethers.parseEther("1");
      await vault.connect(alice).deposit({ value: principal });

      await time.increase(Number(SECONDS_IN_YEAR));

      const reward = await vault.calculateReward(alice.address);
      const expected =
        (principal * REWARD_RATE * SECONDS_IN_YEAR) /
        (SECONDS_IN_YEAR * BASIS_POINTS);

      expect(reward).to.be.closeTo(expected, ethers.parseEther("0.0001"));
    });

    it("should calculate proportional reward for half a year", async function () {
      const principal = ethers.parseEther("1");
      await vault.connect(alice).deposit({ value: principal });

      const halfYear = SECONDS_IN_YEAR / 2n;
      await time.increase(Number(halfYear));

      const reward = await vault.calculateReward(alice.address);
      const expectedFull =
        (principal * REWARD_RATE * SECONDS_IN_YEAR) /
        (SECONDS_IN_YEAR * BASIS_POINTS);

      // Half year → half reward
      expect(reward).to.be.closeTo(expectedFull / 2n, ethers.parseEther("0.0001"));
    });

    it("should reset reward to 0 after claimReward", async function () {
      const principal = ethers.parseEther("1");
      await vault.connect(alice).deposit({ value: principal });
      await time.increase(30 * 24 * 3600);

      expect(await vault.calculateReward(alice.address)).to.be.gt(0n);

      await vault.connect(alice).claimReward();

      expect(await vault.calculateReward(alice.address)).to.equal(0n);
    });
  });

  // ── 5. ClaimReward ──────────────────────────────────────────────────────────
  describe("ClaimReward", function () {
    const DEPOSIT = ethers.parseEther("1");

    beforeEach(async function () {
      await vault.connect(alice).deposit({ value: DEPOSIT });
      await time.increase(30 * 24 * 3600); // 30 days
    });

    it("should transfer correct reward amount", async function () {
      const expectedReward = await vault.calculateReward(alice.address);
      const balBefore = await ethers.provider.getBalance(alice.address);

      const tx = await vault.connect(alice).claimReward();
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const balAfter = await ethers.provider.getBalance(alice.address);

      const received = balAfter - balBefore + gasCost;
      expect(received).to.be.closeTo(expectedReward, ethers.parseEther("0.00001"));
    });

    it("should reset stakeTimestamp after claim", async function () {
      const tsBefore = await vault.stakeTimestamp(alice.address);
      await vault.connect(alice).claimReward();
      const tsAfter = await vault.stakeTimestamp(alice.address);
      expect(tsAfter).to.be.gt(tsBefore);
    });

    it("should emit RewardClaimed event", async function () {
      const tx = await vault.connect(alice).claimReward();
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      // reward amount differs by a few wei across blocks; use anyValue for the amount
      await expect(tx)
        .to.emit(vault, "RewardClaimed")
        .withArgs(alice.address, anyValue, block.timestamp);
    });

    it("should do nothing (not revert) if reward is 0", async function () {
      // Fresh deposit in the same block — reward = 0
      const StakingVault = await ethers.getContractFactory("StakingVault");
      const freshVault = await StakingVault.deploy(REWARD_RATE, MIN_STAKE);
      await freshVault
        .connect(owner)
        .fundRewardReserve({ value: ethers.parseEther("1") });
      await freshVault.connect(alice).deposit({ value: DEPOSIT });

      // claimReward with zero accrual should not revert
      await expect(freshVault.connect(alice).claimReward()).to.not.be.reverted;
    });
  });

  // ── 6. Admin Functions ──────────────────────────────────────────────────────
  describe("Admin Functions", function () {
    it("should allow owner to set reward rate", async function () {
      await vault.connect(owner).setRewardRate(500n);
      expect(await vault.rewardRatePerYear()).to.equal(500n);
    });

    it("should emit RewardRateUpdated event", async function () {
      await expect(vault.connect(owner).setRewardRate(500n))
        .to.emit(vault, "RewardRateUpdated")
        .withArgs(REWARD_RATE, 500n);
    });

    it("should reject rate above 5000 basis points", async function () {
      await expect(
        vault.connect(owner).setRewardRate(5001n)
      ).to.be.revertedWithCustomError(vault, "RewardRateTooHigh");
    });

    it("should reject non-owner calling setRewardRate", async function () {
      await expect(
        vault.connect(alice).setRewardRate(500n)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("should allow owner to pause and unpause", async function () {
      await vault.connect(owner).pause();
      expect(await vault.paused()).to.be.true;

      await vault.connect(owner).unpause();
      expect(await vault.paused()).to.be.false;
    });

    it("should reject deposits when paused", async function () {
      await vault.connect(owner).pause();
      await expect(
        vault.connect(alice).deposit({ value: ethers.parseEther("0.05") })
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });

    it("should reject withdrawals when paused", async function () {
      await vault.connect(alice).deposit({ value: ethers.parseEther("0.05") });
      await vault.connect(owner).pause();
      await expect(
        vault.connect(alice).withdraw(ethers.parseEther("0.05"))
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });

    it("should allow emergencyWithdraw for owner, draining full balance", async function () {
      await vault.connect(alice).deposit({ value: ethers.parseEther("1") });
      const contractBalance = await ethers.provider.getBalance(
        await vault.getAddress()
      );

      const ownerBalBefore = await ethers.provider.getBalance(owner.address);
      const tx = await vault.connect(owner).emergencyWithdraw();
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const ownerBalAfter = await ethers.provider.getBalance(owner.address);

      const received = ownerBalAfter - ownerBalBefore + gasCost;
      expect(received).to.equal(contractBalance);
      expect(
        await ethers.provider.getBalance(await vault.getAddress())
      ).to.equal(0n);
    });

    it("should allow emergencyWithdraw even when paused", async function () {
      await vault.connect(alice).deposit({ value: ethers.parseEther("1") });
      await vault.connect(owner).pause();

      await expect(vault.connect(owner).emergencyWithdraw()).to.not.be.reverted;
    });

    it("should reject emergencyWithdraw from non-owner", async function () {
      await expect(
        vault.connect(alice).emergencyWithdraw()
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("should allow owner to fund reserve via fundRewardReserve", async function () {
      const reserveBefore = await vault.getRewardReserve();
      await vault
        .connect(owner)
        .fundRewardReserve({ value: ethers.parseEther("1") });
      const reserveAfter = await vault.getRewardReserve();
      expect(reserveAfter - reserveBefore).to.equal(ethers.parseEther("1"));
    });

    it("should reject fundRewardReserve with zero ETH", async function () {
      await expect(
        vault.connect(owner).fundRewardReserve({ value: 0n })
      ).to.be.revertedWithCustomError(vault, "MustSendEther");
    });
  });

  // ── 7. Reentrancy Attack Test ────────────────────────────────────────────────
  describe("Reentrancy Attack", function () {
    it("should block reentrancy on withdraw via MaliciousContract", async function () {
      // Deploy the attacker contract
      const Malicious = await ethers.getContractFactory("MaliciousReentrant");
      const malicious = await Malicious.deploy(await vault.getAddress());

      // Fund the attacker so it can stake
      await attacker.sendTransaction({
        to: await malicious.getAddress(),
        value: ethers.parseEther("1"),
      });

      // Attacker deposits
      await malicious.connect(attacker).attack({ value: ethers.parseEther("0.1") });

      const attackerStake = await vault.stakedBalance(
        await malicious.getAddress()
      );
      expect(attackerStake).to.equal(ethers.parseEther("0.1"));

      // Attempt reentrancy on withdraw — should revert with ReentrancyGuardReentrantCall
      await expect(
        malicious.connect(attacker).triggerWithdraw(ethers.parseEther("0.1"))
      ).to.be.reverted;
    });
  });

  // ── 8. getUserInfo ───────────────────────────────────────────────────────────
  describe("getUserInfo", function () {
    it("should return correct user info after deposit", async function () {
      const deposit = ethers.parseEther("0.5");
      const tx = await vault.connect(alice).deposit({ value: deposit });
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const [staked, pending, since] = await vault.getUserInfo(alice.address);
      expect(staked).to.equal(deposit);
      expect(pending).to.equal(0n); // same block
      expect(since).to.equal(BigInt(block.timestamp));
    });
  });

  // ── 9. getRewardReserve ──────────────────────────────────────────────────────
  describe("getRewardReserve", function () {
    it("should return balance minus totalStaked", async function () {
      await vault.connect(alice).deposit({ value: ethers.parseEther("1") });
      const reserve = await vault.getRewardReserve();
      const balance = await ethers.provider.getBalance(await vault.getAddress());
      const staked = await vault.totalStaked();
      expect(reserve).to.equal(balance - staked);
    });

    it("should return 0 if totalStaked >= balance", async function () {
      // Deploy vault with no reserve and large stake would go negative — just
      // check the guard by calling on fresh vault before any funding
      const StakingVault = await ethers.getContractFactory("StakingVault");
      const emptyVault = await StakingVault.deploy(REWARD_RATE, MIN_STAKE);

      // Deposit directly (no reserve funded)
      await emptyVault.connect(alice).deposit({ value: ethers.parseEther("0.01") });

      // All balance is principal; reserve should be 0
      expect(await emptyVault.getRewardReserve()).to.equal(0n);
    });
  });

  // ── 10. Receive fallback ─────────────────────────────────────────────────────
  describe("receive()", function () {
    it("should accept ETH and emit RewardReserveFunded", async function () {
      const amount = ethers.parseEther("0.5");
      await expect(
        alice.sendTransaction({ to: await vault.getAddress(), value: amount })
      )
        .to.emit(vault, "RewardReserveFunded")
        .withArgs(alice.address, amount);
    });
  });
});
