import { requireAddress, type Address } from '../shared/address.ts';
import { recoverMessageAddress } from 'viem';

export async function verifySig(
  message: string,
  signature: string,
  expected: Address,
): Promise<boolean> {
  try {
    const recovered = await recoverMessageAddress({
      message,
      signature: signature as `0x${string}`,
    });
    return requireAddress(recovered) === expected;
  } catch {
    return false;
  }
}
