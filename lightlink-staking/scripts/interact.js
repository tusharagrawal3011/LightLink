/**
 * interact.js — Full end-to-end demo of StakingVault: deposit, check, claim, withdraw.
 *
 * Usage:
 *   npx hardhat run scripts/interact.js --network lightlink_pegasus
 *   npx hardhat run scripts/interact.js --network lightlink_phoenix
 *
 * Requires deployments.json to exist (run deploy.js first).
 */

const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function printContractState(vault, label) {
  const totalStaked = await vault.totalStaked();
  const rewardRate = await vault.rewardRatePerYear();
  const reserve = await vault.getRewardReserve();
  const balance = await ethers.provider.getBalance(await vault.getAddress());

  console.log(`\n── ${label} ────────────────────────────────`);
  console.log("  Reward rate  :", rewardRate.toString(), "bp");
  console.log("  Total staked :", ethers.formatEther(totalStaked), "ETH");
  console.log("  Reserve      :", ethers.formatEther(reserve), "ETH");
  console.log("  Vault balance:", ethers.formatEther(balance), "ETH");
}

async function main() {
  // ── Load deployment address ─────────────────────────────────────────────────
  const deploymentsPath = path.join(__dirname, "..", "deployments.json");
  if (!fs.existsSync(deploymentsPath)) {
    throw new Error("deployments.json not found — run deploy.js first");
  }

  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  const networkName = hre.network.name;

  if (!deployments[networkName]) {
    throw new Error(
      `No deployment found for network "${networkName}" in deployments.json`
    );
  }

  const contractAddress = deployments[networkName].address;
  console.log("Using StakingVault at:", contractAddress);
  console.log("Network              :", networkName);

  const vault = await ethers.getContractAt("StakingVault", contractAddress);
  const [user] = await ethers.getSigners();
  console.log("User address         :", user.address);

  // ── 1. Initial state ────────────────────────────────────────────────────────
  await printContractState(vault, "Initial State");

  // ── 2. Deposit 0.05 ETH ────────────────────────────────────────────────────
  console.log("\n[ACTION] Depositing 0.05 ETH...");
  const depositTx = await vault.deposit({ value: ethers.parseEther("0.05") });
  await depositTx.wait();
  console.log("  Deposit tx hash:", depositTx.hash);

  const balAfterDeposit = await vault.stakedBalance(user.address);
  console.log(
    "  Staked balance :",
    ethers.formatEther(balAfterDeposit),
    "ETH"
  );

  // ── 3. getUserInfo ──────────────────────────────────────────────────────────
  console.log("\n[QUERY] getUserInfo...");
  const [staked, pendingReward, stakedSince] = await vault.getUserInfo(
    user.address
  );
  console.log("  Staked       :", ethers.formatEther(staked), "ETH");
  console.log(
    "  Pending reward:",
    ethers.formatEther(pendingReward),
    "ETH"
  );
  console.log("  Staked since :", new Date(Number(stakedSince) * 1000).toISOString());

  // ── 4. calculateReward ──────────────────────────────────────────────────────
  console.log("\n[QUERY] calculateReward...");
  const reward1 = await vault.calculateReward(user.address);
  console.log("  Current reward:", ethers.formatEther(reward1), "ETH");

  // ── 5. Wait 2 seconds (simulate time passing) ───────────────────────────────
  console.log("\n[WAIT] Sleeping 2 seconds to let reward accrue...");
  await sleep(2_000);

  const reward2 = await vault.calculateReward(user.address);
  console.log("  Reward after wait:", ethers.formatEther(reward2), "ETH");

  // ── 6. claimReward ──────────────────────────────────────────────────────────
  console.log("\n[ACTION] Claiming reward...");
  const balBefore = await ethers.provider.getBalance(user.address);
  const claimTx = await vault.claimReward();
  const claimReceipt = await claimTx.wait();
  const balAfter = await ethers.provider.getBalance(user.address);

  // Net change (reward minus gas)
  const gasCost = claimReceipt.gasUsed * claimReceipt.gasPrice;
  const netReward = balAfter - balBefore + gasCost;
  console.log("  Claim tx hash  :", claimTx.hash);
  console.log("  Reward received:", ethers.formatEther(netReward), "ETH (net of gas)");

  // ── 7. Withdraw full balance ────────────────────────────────────────────────
  console.log("\n[ACTION] Withdrawing full principal...");
  const principalToWithdraw = await vault.stakedBalance(user.address);
  console.log("  Withdrawing    :", ethers.formatEther(principalToWithdraw), "ETH");

  const bal2Before = await ethers.provider.getBalance(user.address);
  const withdrawTx = await vault.withdraw(principalToWithdraw);
  const withdrawReceipt = await withdrawTx.wait();
  const bal2After = await ethers.provider.getBalance(user.address);

  const gasWithdraw = withdrawReceipt.gasUsed * withdrawReceipt.gasPrice;
  const netWithdrawn = bal2After - bal2Before + gasWithdraw;
  console.log("  Withdraw tx hash:", withdrawTx.hash);
  console.log(
    "  Net received    :",
    ethers.formatEther(netWithdrawn),
    "ETH (principal + reward, net of gas)"
  );

  // ── 8. Final state ──────────────────────────────────────────────────────────
  await printContractState(vault, "Final State");

  console.log("\n✓ Interaction demo complete");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
