// verify-smtp.ts
import 'dotenv/config';
import { verifyEtherealSmtpWithTimeout } from '../src/services/etherealEmail';

(async () => {
  try {
    await verifyEtherealSmtpWithTimeout();
    console.log('[smtp-verify] Verification succeeded');
    process.exit(0);
  } catch (err) {
    console.error('[smtp-verify] Verification failed', err);
    process.exit(1);
  }
})();
