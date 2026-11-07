// Read-only verification of the Sepolia demo deployment and its disabled integrations.
const fs = require('node:fs');
const { createPublicClient, http, parseAbi, zeroAddress } = require('viem');

async function main() {
  const deployment = JSON.parse(fs.readFileSync(process.argv[2] || 'contracts/deployments/sepolia-demo-11155111.json', 'utf8'));
  const client = createPublicClient({ transport: http(process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com') });
  if (await client.getChainId() !== 11155111) throw Error('RPC is not Sepolia');
  const abi = parseAbi([
    'function owner() view returns (address)', 'function asset() view returns (address)',
    'function safeLeg() view returns (address)', 'function riskGate() view returns (address)',
    'function agentWallet() view returns (address)', 'function harvestRouter() view returns (address)',
    'function vault() view returns (address)', 'function wallet() view returns (address)',
    'function flashSpender() view returns (address)', 'function count() view returns (uint256)',
    'function computeTreasury() view returns (address)', 'function allowedVaults(address) view returns (bool)',
    'function rateBps() view returns (uint256)', 'function token() view returns (address)',
    'function ccipRouter() view returns (address)',
  ]);
  const read = (address, functionName, args) => client.readContract({ address, abi, functionName, args });
  const equal = (actual, expected, label) => {
    if (String(actual).toLowerCase() !== String(expected).toLowerCase()) throw Error(`${label}: ${actual} != ${expected}`);
  };
  const addresses = [deployment.safeLeg, deployment.harvestRouter, deployment.registry];
  for (const name of ['Atlas', 'Halcyon', 'Ember']) {
    const agent = typeof deployment[name] === 'string' ? JSON.parse(deployment[name]) : deployment[name];
    addresses.push(agent.vault, agent.wallet, agent.riskGate);
    for (const [contract, method, expected] of [
      [agent.vault, 'owner', deployment.owner], [agent.vault, 'asset', deployment.usdc],
      [agent.vault, 'safeLeg', deployment.safeLeg], [agent.vault, 'riskGate', agent.riskGate],
      [agent.vault, 'agentWallet', agent.wallet], [agent.vault, 'harvestRouter', deployment.harvestRouter],
      [agent.wallet, 'owner', deployment.owner], [agent.wallet, 'vault', agent.vault],
      [agent.wallet, 'riskGate', agent.riskGate], [agent.wallet, 'flashSpender', zeroAddress],
      [agent.riskGate, 'owner', deployment.owner], [agent.riskGate, 'vault', agent.vault],
      [agent.riskGate, 'wallet', agent.wallet],
    ]) equal(await read(contract, method), expected, `${name} ${method}`);
    equal(await read(deployment.harvestRouter, 'allowedVaults', [agent.vault]), false, `${name} bridge disabled`);
  }
  for (const address of addresses) if ((await client.getBytecode({ address })) === undefined) throw Error(`Missing bytecode: ${address}`);
  for (const address of [deployment.safeLeg, deployment.harvestRouter, deployment.registry]) equal(await read(address, 'owner'), deployment.owner, 'owner');
  equal(await read(deployment.registry, 'count'), 3, 'registry count');
  equal(await read(deployment.harvestRouter, 'computeTreasury'), zeroAddress, 'treasury disabled');
  equal(await read(deployment.harvestRouter, 'ccipRouter'), deployment.ccipRouter, 'CCIP router');
  equal(await read(deployment.safeLeg, 'token'), deployment.usdc, 'lending token');
  equal(await read(deployment.safeLeg, 'rateBps'), 0, 'test lending yield');
  console.log('Verified Sepolia bytecode, ownership, three agent connections, and disabled trading/bridge configuration.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
