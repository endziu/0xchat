import { describe, expect, test } from "bun:test";
import { isValidPushSubscription } from "./validation.ts";

const keys = {
  p256dh: Buffer.alloc(65, 1).toString("base64url"),
  auth: Buffer.alloc(16, 2).toString("base64url"),
};

describe("push subscription validation", () => {
  test("accepts a Microsoft Edge for Windows push endpoint", () => {
    expect(
      isValidPushSubscription({
        endpoint:
          "https://wns2-db5p.notify.windows.com/w/?token=desktop-pwa-token",
        keys,
      }),
    ).toBe(true);
  });

  test("rejects a lookalike Windows push host", () => {
    expect(
      isValidPushSubscription({
        endpoint:
          "https://notify.windows.com.attacker.example/w/?token=desktop-pwa-token",
        keys,
      }),
    ).toBe(false);
  });
});
