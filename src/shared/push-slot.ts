export interface PushSlotHandle {
  slot_id: string;
  installation_id: string;
  revision: number;
}

export interface PushSlotCondition {
  slot_id?: string;
  installation_id: string;
  expected_revision: number;
}

export interface PushSlotSummary extends PushSlotHandle {
  label: string;
  state: 'active' | 'repair_needed';
  created_at: number;
  updated_at: number;
}

export interface PushSlotList {
  slots: PushSlotSummary[];
  revocations: PushSlotHandle[];
}

export interface PushEnableRequest extends PushSlotCondition {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
}
