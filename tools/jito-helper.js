import axios from 'axios';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';

const JITO_BLOCK_ENGINE = process.env.JITO_BLOCK_ENGINE || 'https://ny.mainnet.block-engine.jito.wtf';
const JITO_TIP_LAMPORTS = Number(process.env.JITO_TIP_LAMPORTS) || 1_000_000;

let _cachedTipAccounts = null;
let _cachedAt = 0;

async function getTipAccount(log) {
  const ONE_HOUR = 60 * 60 * 1000;
  if (_cachedTipAccounts && Date.now() - _cachedAt < ONE_HOUR) {
    return _cachedTipAccounts[Math.floor(Math.random() * _cachedTipAccounts.length)];
  }
  const response = await axios.post(`${JITO_BLOCK_ENGINE}/api/v1/bundles`, {
    jsonrpc: '2.0',
    id: 1,
    method: 'getTipAccounts',
    params: [],
  }, { timeout: 5000 });

  const accounts = response.data?.result;
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('Jito getTipAccounts returned no accounts');
  }
  _cachedTipAccounts = accounts;
  _cachedAt = Date.now();
  log?.('jito', `Fetched ${accounts.length} tip accounts from Jito`);
  return accounts[Math.floor(Math.random() * accounts.length)];
}

export async function sendJitoBundle(connection, transaction, signers, logger = null) {
  const log = (prefix, msg) => {
    if (logger) logger(prefix, msg);
    else console.log(`[${prefix}]`, msg);
  };

  const feePayer = signers[0];

  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = feePayer.publicKey;
  transaction.sign(...signers);

  const tipAccount = await getTipAccount(log);

  const tipTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: feePayer.publicKey,
      toPubkey: new PublicKey(tipAccount),
      lamports: JITO_TIP_LAMPORTS,
    }),
  );
  tipTx.recentBlockhash = blockhash;
  tipTx.feePayer = feePayer.publicKey;
  tipTx.sign(feePayer);

  const bundle = [
    bs58.encode(tipTx.serialize()),
    bs58.encode(transaction.serialize()),
  ];

  log('jito', `Submitting bundle (tip ${JITO_TIP_LAMPORTS / 1e9} SOL -> ${tipAccount}) to ${JITO_BLOCK_ENGINE}`);
  const response = await axios.post(`${JITO_BLOCK_ENGINE}/api/v1/bundles`, {
    jsonrpc: '2.0',
    id: 1,
    method: 'sendBundle',
    params: [bundle],
  }, { timeout: 5000 });

  if (response.data?.error) {
    throw new Error(`Jito API error: ${JSON.stringify(response.data.error)}`);
  }
  if (!response.data?.result) {
    throw new Error('Jito returned no bundle result');
  }

  log('jito', `Bundle accepted, ID: ${response.data.result}`);
  return response.data.result;
}
