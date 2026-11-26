import { foodicsConnector } from './foodics.js';
import { simphonyConnector } from './simphony.js';

// "manual": for any POS whose API does not expose open bills (e.g. Loyverse, Square open
// tickets). Bills come from the dashboard or the signed POS API, and every paid amount is
// queued for staff to record in the POS with one click.
const manual = {
  name: 'manual',
  label: 'Manual / other POS (Loyverse…)',
  capabilities: { oauth: false, liveBill: false, writeBack: false, listTables: false },
  isConfigured: () => true,
  async test() {
    return { ok: true };
  },
};

export function createConnectors(platform) {
  return {
    foodics: foodicsConnector(platform),
    simphony: simphonyConnector(platform),
    manual,
  };
}
