/**
 * deploy.js — Deploy StakingVault to the target network and fund its reward reserve.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js --network lightlink_pegasus
 *   npx hardhat run scripts/deploy.js --network lightlink_phoenix
 */

const { ethers } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer address :", deployer.address);
  console.log(
    "Deployer balance  :",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)),
    "ETH"
  );

  // ── Deploy ──────────────────────────────────────────────────────────────────
  const rewardRatePerYear = 1_000; // 10% APY in basis points
  const minimumStake = ethers.parseEther("0.01");

  console.log("\nDeploying StakingVault...");
  const StakingVault = await ethers.getContractFactory("StakingVault");
  const vault = await StakingVault.deploy(rewardRatePerYear, minimumStake);
  await vault.waitForDeployment();

  const contractAddress = await vault.getAddress();
  const deployTx = vault.deploymentTransaction();

  console.log("Contract address  :", contractAddress);
  console.log("Deploy tx hash    :", deployTx.hash);

  // ── Fund reward reserve ─────────────────────────────────────────────────────
  console.log("\nFunding reward reserve with 0.1 ETH...");
  const fundTx = await vault.fundRewardReserve({
    value: ethers.parseEther("0.1"),
  });
  await fundTx.wait();
  console.log("Fund tx hash      :", fundTx.hash);

  const reserve = await vault.getRewardReserve();
  console.log("Reward reserve    :", ethers.formatEther(reserve), "ETH");

  // ── Persist deployment info ─────────────────────────────────────────────────
  const deploymentsPath = path.join(__dirname, "..", "deployments.json");
  let deployments = {};
  if (fs.existsSync(deploymentsPath)) {
    deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  }

  const networkName = hre.network.name;
  deployments[networkName] = {
    address: contractAddress,
    deployer: deployer.address,
    deployTxHash: deployTx.hash,
    rewardRatePerYear,
    minimumStake: minimumStake.toString(),
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log(`\nDeployment saved  : deployments.json (network: ${networkName})`);

  console.log("\n✓ Deployment complete");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
