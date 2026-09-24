import { json } from './http.ts';
import { closeIncompatibleClients } from './sse.ts';
import { hasRecipientOpeningMessages } from './db.ts';
import { advertisesDeliveryCapability, type DeliveryPolicy } from '../shared/message-envelope.ts';

export const CLIENT_UPDATE_REQUIRED = 'client_update_required';

export function clientUpdateRequired(): Response {
  return json({ error: 'This 0xChat client is out of date. Reload the page or update the CLI.', code: CLIENT_UPDATE_REQUIRED }, 426);
}

let activations = 0;

/**
 * Release gate for recipient-opening expiry. Acceptance of the new policy and
 * rejection of clients that do not advertise the delivery capability switch on
 * together.
 */
export class LifecycleGate {
  private accepting = false;
  /** Identifies the latest activation; live tokens minted before it are refused. */
  activation = 0;

  constructor(accepting = false) {
    if (accepting) this.activate();
  }

  /** Policy for newly accepted messages. */
  get acceptancePolicy(): DeliveryPolicy {
    return this.accepting ? 'recipient-opening' : 'legacy';
  }

  /**
   * Turning acceptance off after activation (rollback) stores future messages
   * as legacy, but clients must stay lifecycle-aware while new-policy messages
   * remain available. Derived from stored data, so it survives restarts.
   */
  enforced(): boolean {
    return this.accepting || hasRecipientOpeningMessages();
  }

  /** Whether a request must be rejected with client_update_required. */
  rejects(req: Request): boolean {
    return this.enforced() && !advertisesDeliveryCapability(req.headers);
  }

  /** Incompatible streams close before any new-policy message can be published. */
  activate(): void {
    this.accepting = true;
    this.activation = ++activations;
    closeIncompatibleClients();
  }
}
