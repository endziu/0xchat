import { recoverMessageAddress } from 'viem';

export async function verifySig(
  message: string,
  signature: string,
  expected: string,
): Promise<boolean> {
  try {
    const recovered = await recoverMessageAddress({
      message,
      signature: signature as `0x${string}`,
    });
    return recovered.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}
