import { generateVapidKeys } from '../config';

/**
 * Print a fresh VAPID key pair for the .env file:
 *
 *   npm run vapid:keys --workspace @lifementor/server
 *
 * Copy the values into .env as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY and set a real
 * VAPID_SUBJECT (an email or https URL, e.g. mailto:you@example.com) in production.
 */
const keys = generateVapidKeys();
console.log('# LifeMentor server VAPID keys (Web Push). Add to .env:');
console.log(`VAPID_PUBLIC_KEY=${keys.public_key}`);
console.log(`VAPID_PRIVATE_KEY=${keys.private_key}`);
console.log('VAPID_SUBJECT=mailto:you@example.com');
