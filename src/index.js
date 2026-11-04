import express from 'express';
import { startBot } from './bot.js';
import { startChainWatcher } from './chain.js';
import { config, requireConfig } from './config.js';
import { routes } from './routes.js';
import { sealOldCards } from './cards.js';
import { addSoundboxKeys, startDirectPoller, startExpirySweeper } from './sales.js';

requireConfig();
// Test cards aren't free in direct mode: Bitrefill charges the customer real USDC for them.
if (config.PAY_MODE === 'direct' && config.BITREFILL_TEST_MODE) {
  throw new Error('PAY_MODE=direct charges real USDC even for test cards. Set BITREFILL_TEST_MODE=false to use it.');
}

sealOldCards();
addSoundboxKeys();

const app = express();
app.use(express.json());
app.use(routes);

app.listen(config.PORT, () => console.log(`Sikka is listening on port ${config.PORT}`));
startBot();
if (config.PAY_MODE === 'direct') startDirectPoller();
else startChainWatcher();
startExpirySweeper();
