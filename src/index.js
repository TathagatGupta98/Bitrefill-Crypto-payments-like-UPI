import express from 'express';
import { startBot } from './bot.js';
import { startChainWatcher } from './chain.js';
import { config, requireConfig } from './config.js';
import { routes } from './routes.js';
import { startExpirySweeper } from './sales.js';

requireConfig();

const app = express();
app.use(express.json());
app.use(routes);

app.listen(config.PORT, () => console.log(`Sikka is listening on port ${config.PORT}`));
startBot();
startChainWatcher();
startExpirySweeper();
