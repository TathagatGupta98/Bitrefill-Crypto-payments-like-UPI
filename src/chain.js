import { createPublicClient, formatUnits, http, isAddress, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import { config } from './config.js';
import { db, findPayableSale, getChainCursor, markLogSeen, saleRef, setChainCursor, sqlTime, transition } from './db.js';
import { fulfillSale } from './fulfill.js';

const POLL_MS = 4_000;
const MAX_BLOCKS_PER_CALL = 500n;
const FIRST_RUN_LOOKBACK = 50n;
// Stays just behind the tip: public RPC nodes can lag and return no logs for a block they
// haven't seen, which would move the cursor past a real payment. It also skips shallow reorgs.
const CONFIRMATIONS = 2n;

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

const client = createPublicClient({ chain: base, transport: http(config.BASE_RPC_URL) });

// All in one transaction, so a crash can't record a log as seen without marking its sale paid.
const claimTransfer = db.transaction((log) => {
  if (!markLogSeen(log.transactionHash, log.logIndex)) return { duplicate: true };

  const sale = findPayableSale(log.args.value.toString());
  if (!sale) return {};

  transition(sale.id, 'awaiting_payment', 'paid', {
    paid_at: sqlTime(),
    payer_tx_hash: log.transactionHash,
    payer_address: log.args.from,
  });
  return { sale };
});

function handleTransfer(log) {
  const { duplicate, sale } = claimTransfer(log);
  if (duplicate) return;

  const usdc = formatUnits(log.args.value, 6);
  if (!sale) {
    console.log(`Unmatched transfer of ${usdc} USDC from ${log.args.from} in ${log.transactionHash}`);
    return;
  }

  console.log(`Sale ${saleRef(sale.id)} paid: ${usdc} USDC in ${log.transactionHash}`);
  fulfillSale(sale.id).catch((err) => console.error(`Sale ${saleRef(sale.id)} failed: ${err.message}`));
}

async function checkNewBlocks() {
  const latest = (await client.getBlockNumber()) - CONFIRMATIONS;
  const cursor = getChainCursor();
  const fromBlock = cursor === null ? latest - FIRST_RUN_LOOKBACK : BigInt(cursor) + 1n;
  if (fromBlock > latest) return;

  const lastInRange = fromBlock + MAX_BLOCKS_PER_CALL - 1n;
  const toBlock = lastInRange < latest ? lastInRange : latest;
  const logs = await client.getLogs({
    address: config.USDC_BASE_ADDRESS,
    event: TRANSFER,
    args: { to: config.RECEIVE_ADDRESS },
    fromBlock,
    toBlock,
  });

  logs.forEach(handleTransfer);
  setChainCursor(toBlock);
}

export function startChainWatcher() {
  // Checked here because customers are told to send USDC to this address.
  if (!isAddress(config.RECEIVE_ADDRESS)) {
    throw new Error(`RECEIVE_ADDRESS is not a valid address: ${config.RECEIVE_ADDRESS}`);
  }

  const tick = async () => {
    try {
      await checkNewBlocks();
    } catch (err) {
      // Public RPC rate limits are expected. The cursor hasn't moved, so the next tick retries.
      console.error(`Chain check failed: ${err.shortMessage ?? err.message}`);
    }
    setTimeout(tick, POLL_MS);
  };
  tick();
}
